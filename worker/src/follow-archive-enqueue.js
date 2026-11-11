// Dormant single-subscriber coordination. No enumeration, scheduling or sending.
import { createFollowArchiveReader } from "./follow-archive-reader.js";
import { enqueueFollowSnapshot } from "./follow-enqueue.js";
import { followInstant } from "./follow-matching.js";
import { readFollowProgress } from "./follow-progress.js";

const invalid = (reason) => ({ status: "invalid", reason });

export async function enqueueFollowArchiveSubscriber(
  db,
  subscriberId,
  { archive, catalog, limits, maxProgressBytes, maxPendingBytes } = {},
) {
  const readClock = archive?.clock;
  if (typeof readClock !== "function") return invalid("archive_admission");
  let latestTime = -Infinity;
  function clock() {
    const value = readClock();
    const time =
      value instanceof Date && Number.isFinite(+value) ? followInstant(value.toISOString()) : null;
    if (time === null || time < latestTime) return new Date(NaN);
    latestTime = time;
    return new Date(time);
  }
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
  return enqueueFollowSnapshot(
    db,
    subscriberId,
    latest.bytes,
    {
      catalog,
      limits,
      upperBound: latest.at,
      maxProgressBytes,
      maxPendingBytes,
      archiveAdmission: { enqueueUntil: latest.enqueueUntil, clock },
    },
    clock(),
  );
}
