// Dormant bounded pages. Continuations are caller-owned scheduling hints, never consent.
import { deliverFollowConfirmation } from "./follow-confirmation-delivery.js";
import { deliverFollowManagement } from "./follow-management-delivery.js";
import { followBudgetStamp, validFollowSendCap } from "./follow-send-budget.js";
const kinds = ["confirmation", "management"];
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const stamp = (v) =>
  typeof v === "string" &&
  v.length === 24 &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
const exact = (v, keys) =>
  v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === keys;
const later = (a, b) =>
  a.expires_at > b.expires_at || (a.expires_at === b.expires_at && a.id > b.id);
function cursor(value) {
  if (value === null) return null;
  if (
    !exact(value, "expires_at,id") ||
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    !stamp(value.expires_at)
  )
    throw new Error();
  return { expires_at: value.expires_at, id: value.id };
}
function receipts(batch, size) {
  if (!Array.isArray(batch) || batch.length !== size) throw new Error();
  for (let i = 0; i < size; i++)
    if (
      !Object.hasOwn(batch, i) ||
      batch[i]?.success !== true ||
      batch[i].meta?.changes !== 0 ||
      !Array.isArray(batch[i].results)
    )
      throw new Error();
  return batch.map((r) => r.results);
}
export async function runFollowLinkDispatch({
  enabled = false,
  db,
  cap,
  maxCandidates,
  clock,
  confirmation,
  management,
  transport,
  continuation = { confirmation: null, management: null, nextKind: "confirmation" },
} = {}) {
  const counts = { examined: 0, accepted: 0, uncertain: 0, unavailable: 0, skipped: 0 };
  let next = null;
  const finish = (status) => ({
    status,
    counts: { ...counts },
    continuation: next && {
      ...next,
      confirmation: next.confirmation && { ...next.confirmation },
      management: next.management && { ...next.management },
    },
  });
  if (enabled !== true) return finish("disabled");
  if (
    !validFollowSendCap(cap) ||
    !Number.isSafeInteger(maxCandidates) ||
    maxCandidates < 1 ||
    maxCandidates > 64 ||
    [clock, transport, confirmation?.present, management?.buildLinks].some(
      (f) => typeof f !== "function",
    )
  )
    return finish("unavailable");
  try {
    if (
      !exact(continuation, "confirmation,management,nextKind") ||
      !kinds.includes(continuation.nextKind)
    )
      throw new Error();
    next = {
      confirmation: cursor(continuation.confirmation),
      management: cursor(continuation.management),
      nextKind: continuation.nextKind,
    };
    const present = confirmation.present,
      buildLinks = management.buildLinks;
    const presentation = {
      from: management.presentation?.from,
      postalAddress: management.presentation?.postalAddress,
      origins: Array.isArray(management.presentation?.origins)
        ? [...management.presentation.origins]
        : null,
    };
    let previous = "",
      databasePrevious = "",
      exhausted = false,
      day;
    const fresh = () => {
      const value = clock();
      if (!(value instanceof Date)) {
        Promise.resolve(value).catch(() => {});
        throw new Error();
      }
      const at = followBudgetStamp(value);
      if (!at || at < previous || (day && at.slice(0, 10) !== day)) throw new Error();
      previous = at;
      day ??= at.slice(0, 10);
      return new Date(at);
    };
    const admitted = async () => {
      fresh();
      const [rows] = receipts(
        await db.batch([
          db.prepare(
            `SELECT ${NOW} AS at,b.observed_at,b.attempts FROM (SELECT 1) LEFT JOIN follow_send_budget b ON b.slot=1`,
          ),
        ]),
        1,
      );
      fresh();
      const at = rows[0]?.at;
      if (
        rows.length !== 1 ||
        !exact(rows[0], "at,attempts,observed_at") ||
        !stamp(at) ||
        at < databasePrevious ||
        at.slice(0, 10) !== day
      )
        throw new Error();
      const { observed_at: observed, attempts } = rows[0];
      if (observed === null && attempts === null) exhausted = false;
      else {
        if (!stamp(observed) || observed > at || !Number.isSafeInteger(attempts) || attempts < 0)
          throw new Error();
        exhausted = observed.slice(0, 10) === day && attempts >= cap;
      }
      databasePrevious = at;
      return at;
    };
    let at = await admitted();
    if (exhausted) return finish("paused");
    const queries = kinds.map((kind) => {
      const table = `follow_${kind}_outbox`,
        after = next[kind];
      // No residual eligibility predicate: LIMIT also bounds examined candidate rows.
      const beyond = after && after.expires_at > at;
      return db
        .prepare(
          `SELECT id,queued_at,expires_at FROM ${table} INDEXED BY ${table}_dispatch WHERE claim_id IS NULL AND ` +
            (beyond ? "(expires_at,id)>(?,?)" : "expires_at>?") +
            " ORDER BY expires_at,id LIMIT ?",
        )
        .bind(...(beyond ? [after.expires_at, after.id] : [at]), maxCandidates);
    });
    const pages = receipts(await db.batch(queries), 2);
    for (let k = 0; k < kinds.length; k++) {
      if (pages[k].length > maxCandidates) throw new Error();
      let last = next[kinds[k]];
      const seen = new Set();
      for (const row of pages[k]) {
        if (
          !exact(row, "expires_at,id,queued_at") ||
          typeof row.id !== "string" ||
          !UUID.test(row.id) ||
          seen.has(row.id) ||
          !stamp(row.queued_at) ||
          !stamp(row.expires_at) ||
          row.queued_at >= row.expires_at ||
          row.expires_at <= at ||
          (last && !later(row, last))
        )
          throw new Error();
        seen.add(row.id);
        last = row;
      }
      if (!pages[k].length) next[kinds[k]] = null; // Wrap only after an observed empty page.
    }
    const offsets = [0, 0];
    while (counts.examined < maxCandidates) {
      let k = kinds.indexOf(next.nextKind);
      if (offsets[k] >= pages[k].length) k = 1 - k;
      if (offsets[k] >= pages[k].length) break;
      at = await admitted();
      const kind = kinds[k];
      if (exhausted) {
        next.nextKind = kind;
        return finish("paused");
      }
      const row = pages[k][offsets[k]++],
        beforeCursor = next[kind];
      counts.examined++;
      next[kind] = { expires_at: row.expires_at, id: row.id };
      next.nextKind = kinds[1 - k];
      if (
        row.queued_at > at ||
        row.queued_at > previous ||
        row.expires_at <= at ||
        row.expires_at <= previous
      ) {
        counts.skipped++;
        continue;
      }
      const common = { db, cap, jobId: row.id, clock: fresh, transport };
      const result =
        kind === "confirmation"
          ? await deliverFollowConfirmation({ ...common, present })
          : await deliverFollowManagement({ ...common, enabled: true, presentation, buildLinks });
      if (!["accepted", "uncertain", "unavailable", "paused"].includes(result?.status))
        throw new Error();
      // Preserve the blocked turn BEFORE a fallible capacity read. An uncertain receipt
      // cannot authorize skipping an unclaimed head; committed claims already fence replay.
      if (result.status === "paused" || result.status === "unavailable") {
        next[kind] = beforeCursor;
        next.nextKind = kind;
        if (result.status === "paused") return finish("paused");
        await admitted();
        if (exhausted) return finish("paused");
        fresh();
        next[kind] = { expires_at: row.expires_at, id: row.id };
        next.nextKind = kinds[1 - k];
      }
      counts[result.status]++;
      if (result.status === "uncertain") return finish("uncertain");
      if (result.status !== "unavailable") fresh();
    }
    return finish("processed");
  } catch {
    return finish("unavailable");
  }
}
