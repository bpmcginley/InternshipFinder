// Dormant archive-qualified enqueue coordination. No scheduling or sending.
import { createFollowArchiveReader } from "./follow-archive-reader.js";
import { enqueueFollowSnapshot } from "./follow-enqueue.js";
import { followInstant } from "./follow-matching.js";
import { readFollowProgress } from "./follow-progress.js";

const invalid = (reason) => ({ status: "invalid", reason });

function monotonicClock(readClock) {
  let latestTime = -Infinity;
  return () => {
    const value = readClock();
    const time =
      value instanceof Date && Number.isFinite(+value) ? followInstant(value.toISOString()) : null;
    if (time === null || time < latestTime) return new Date(NaN);
    latestTime = time;
    return new Date(time);
  };
}

export async function enqueueFollowArchiveSubscriber(
  db,
  subscriberId,
  { archive, catalog, limits, maxProgressBytes, maxPendingBytes } = {},
) {
  const readClock = archive?.clock;
  if (typeof readClock !== "function") return invalid("archive_admission");
  const clock = monotonicClock(readClock);
  const start = clock();
  if (!Number.isFinite(+start)) return invalid("archive_admission");
  const reader = createFollowArchiveReader({ ...archive, clock, catalog, limits });

  let scopes;
  try {
    scopes = await readFollowProgress(db, subscriberId, catalog, {
      upperBound: start.toISOString(),
      maxScopes: limits.maxFollows,
      maxBytes: maxProgressBytes,
    });
  } catch (error) {
    if (error.message === "Invalid follow progress") return invalid("progress");
    throw error;
  }
  if (!scopes.length) return { status: "empty" };
  const effectiveLower = scopes.reduce(
    (oldest, { watermark }) => (watermark < oldest ? watermark : oldest),
    scopes[0].watermark,
  );
  const latest = await reader.latest({ effectiveLower });
  if (latest.status !== "ready") return latest;

  // The transaction rereads and matches the entire current scope set before its CAS.
  // The first read is only for the archive's coverage check.
  return enqueueQualified(db, subscriberId, latest, clock, {
    catalog,
    limits,
    maxProgressBytes,
    maxPendingBytes,
  });
}

function enqueueQualified(db, subscriberId, latest, clock, matching) {
  return enqueueFollowSnapshot(
    db,
    subscriberId,
    latest.bytes,
    {
      ...matching,
      upperBound: latest.at,
      archiveAdmission: { enqueueUntil: latest.enqueueUntil, clock },
    },
    clock(),
  );
}

const subscriberIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const isSubscriberId = (value) =>
  typeof value === "string" && value.length === 36 && subscriberIdPattern.test(value);

// One bounded page for an internal scheduled caller. The cursor describes enumeration only.
// The existing per-subscriber CAS authorizes every mutation and rechecks the latest scopes.
export async function enqueueFollowArchiveBatch(
  db,
  {
    after = null,
    maxSubscribers,
    archive,
    catalog,
    limits,
    maxProgressBytes,
    maxPendingBytes,
  } = {},
) {
  if (
    (after !== null && !isSubscriberId(after)) ||
    !Number.isSafeInteger(maxSubscribers) ||
    maxSubscribers < 1 ||
    maxSubscribers >= Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(maxProgressBytes) ||
    maxProgressBytes < 1 ||
    !Number.isSafeInteger(maxPendingBytes) ||
    maxPendingBytes < 1 ||
    maxPendingBytes > 32768 ||
    limits?.maxFollows >= Number.MAX_SAFE_INTEGER ||
    typeof archive?.clock !== "function"
  )
    return invalid("batch_configuration");

  const monotonic = monotonicClock(archive.clock);
  const start = monotonic();
  if (!Number.isFinite(+start)) return invalid("archive_admission");
  const day = start.toISOString().slice(0, 10);
  function clock() {
    const value = monotonic();
    return Number.isFinite(+value) && value.toISOString().slice(0, 10) === day
      ? value
      : new Date(NaN);
  }

  const { success, results } = await db
    .prepare(
      // Seek the next distinct ID in the confirmed index. GROUP BY would read every scope
      // for each selected ID, even if that subscriber already exceeds the matching bound.
      "WITH RECURSIVE page(id,n) AS (VALUES (?,0) UNION ALL " +
        "SELECT (SELECT min(subscriber_id) FROM follow_subscriptions INDEXED BY follow_confirmed_scopes " +
        "WHERE subscriber_id>page.id AND confirmed_at IS NOT NULL),n+1 " +
        "FROM page WHERE id IS NOT NULL AND n<?) " +
        "SELECT CASE WHEN length(id)=36 THEN id END AS id " +
        "FROM page WHERE n>0 AND id IS NOT NULL ORDER BY n",
    )
    .bind(after ?? "", maxSubscribers + 1)
    .all();
  if (!success || !Array.isArray(results) || results.length > maxSubscribers + 1)
    return invalid("subscriber_page");
  let previous = after ?? "";
  for (const row of results) {
    if (!isSubscriberId(row?.id) || row.id <= previous) return invalid("subscriber_page");
    previous = row.id;
  }
  if (!results.length) return { status: "processed", counts: {}, nextAfter: null };

  const reader = createFollowArchiveReader({ ...archive, clock, catalog, limits });
  const latest = await reader.latestSnapshot();
  if (latest.status !== "ready") return latest;
  const matching = { catalog, limits, maxProgressBytes, maxPendingBytes };
  const counts = {};
  const page = results.slice(0, maxSubscribers);
  for (const { id } of page) {
    // If admission expires after earlier subscribers committed, retry the same cursor.
    const at = clock();
    if (!Number.isFinite(+at) || at.toISOString() >= latest.enqueueUntil)
      return { status: "unavailable" };
    const result = await enqueueQualified(db, id, latest, clock, matching);
    if (result.reason === "archive_admission") return { status: "unavailable" };
    counts[result.status] = (counts[result.status] ?? 0) + 1;
  }
  return {
    status: "processed",
    counts,
    nextAfter: results.length > maxSubscribers ? page.at(-1).id : null,
  };
}
