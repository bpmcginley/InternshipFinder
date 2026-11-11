// Dormant bounded candidate page, not a schedule or a durable progress cursor.
import { deliverFollowSnapshotDigest } from "./follow-digest-delivery.js";
import { followInstant } from "./follow-matching.js";
import { validFollowSendCap } from "./follow-send-budget.js";

export async function runFollowDeliveryTick({ db, maxCandidates, clock, ...delivery }) {
  const counts = {};
  const stop = (status = "unavailable") => ({ status, counts: { ...counts } });
  if (
    !Number.isSafeInteger(maxCandidates) ||
    maxCandidates < 1 ||
    !validFollowSendCap(delivery.cap) ||
    typeof clock !== "function" ||
    [delivery.loadSnapshot, delivery.present, delivery.transport].some(
      (f) => typeof f !== "function",
    )
  )
    return stop();
  let latest = -Infinity,
    databaseLatest = "",
    day;
  const fresh = () => {
    const value = clock();
    const stamp = value instanceof Date && Number.isFinite(+value) ? value.toISOString() : null;
    if (followInstant(stamp) === null || +value < latest || (day && stamp.slice(0, 10) !== day))
      throw new Error("Invalid tick clock");
    latest = +value;
    day ??= stamp.slice(0, 10);
    return new Date(latest);
  };
  async function admitted() {
    const before = fresh().toISOString();
    const result = await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at").all();
    fresh();
    const at = result.results?.[0]?.at;
    if (
      result.success !== true ||
      result.results.length !== 1 ||
      followInstant(at) === null ||
      at < before ||
      at < databaseLatest ||
      at.slice(0, 10) !== day
    )
      throw new Error("Tick database clock unavailable");
    databaseLatest = at;
    return at;
  }
  try {
    await admitted();
    // Both bands seek the existing index. A compound LIMIT bounds examined candidates;
    // no expires_at filter or global sort can scan an unbounded invalid/expired backlog.
    const page = await db
      .prepare(
        "SELECT id,expires_at FROM follow_digest_outbox INDEXED BY follow_digest_outbox_due WHERE state='queued' " +
          "UNION ALL SELECT id,expires_at FROM follow_digest_outbox INDEXED BY follow_digest_outbox_due " +
          "WHERE state='leased' AND lease_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now') LIMIT ?",
      )
      .bind(maxCandidates)
      .all();
    if (
      page.success !== true ||
      !Array.isArray(page.results) ||
      page.results.length > maxCandidates
    )
      return stop();
    const seen = new Set();
    for (const row of page.results) {
      if (
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(row?.id || "") ||
        seen.has(row.id) ||
        followInstant(row.expires_at) === null
      )
        return stop();
      seen.add(row.id);
    }
    let at = await admitted();
    for (const row of page.results) {
      if (row.expires_at <= at || row.expires_at <= fresh().toISOString()) return stop();
      const result = await deliverFollowSnapshotDigest({
        ...delivery,
        db,
        jobId: row.id,
        clock: fresh,
      });
      if (!["accepted", "uncertain", "paused", "unavailable"].includes(result?.status))
        return stop();
      counts[result.status] = (counts[result.status] ?? 0) + 1;
      // Preserve completed outcomes even if either clock prevents the remaining page.
      at = await admitted();
      if (result.status === "paused" || result.status === "unavailable") return stop(result.status);
    }
    return stop("processed");
  } catch {
    return stop();
  }
}
