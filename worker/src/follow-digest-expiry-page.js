import { expiryReceipts } from "./follow-expiry-page.js";

const { record, rowid, dense, receipt } = expiryReceipts;
const unavailable = () => ({ status: "unavailable" });
const table = "follow_digest_outbox";
const kind = "digest";
const clockSql = "SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at";

// One examined job bounds the existing JSON finalization trigger as well as direct mutations.
// No sending, ownership acquisition/reset, persisted cursor or automatic retry.
export async function expireFollowDigestPage(db, options = {}) {
  try {
    const o = record(options);
    if (o.enabled !== true) return { status: "disabled" };
    if (
      o.maxRows !== 1 ||
      Object.keys(o).some((k) => !["enabled", "maxRows", "cursor"].includes(k))
    )
      return unavailable();
    const cursor = o.cursor ?? null;
    let after = null,
      through = null;
    if (cursor !== null) {
      const c = record(cursor);
      if (
        Object.keys(c).sort().join() !== "after,kind,through" ||
        c.kind !== kind ||
        rowid(c.after) > rowid(c.through)
      )
        return unavailable();
      ({ after, through } = c);
    }
    // Preserve the bulk helper's one DB-time sample across both UPDATE bands and deletion.
    const sample = record(await db.prepare(clockSql).all()),
      sampleMeta = record(sample.meta);
    const clockRows = dense(sample.results, 1);
    if (
      sample.success !== true ||
      clockRows.length !== 1 ||
      (Object.hasOwn(sampleMeta, "changes") && sampleMeta.changes !== 0)
    )
      return unavailable();
    const stamp = record(clockRows[0]);
    const at = stamp.at;
    if (
      Object.keys(stamp).join() !== "at" ||
      typeof at !== "string" ||
      !/^\d{4}-/.test(at) ||
      new Date(at).toISOString() !== at
    )
      return unavailable();
    const cutoff = new Date(Date.parse(at) - 7 * 86400000).toISOString();
    const seek =
      after === null
        ? ` WHERE rowid<=(SELECT max(rowid) FROM ${table})`
        : " WHERE rowid>CAST(? AS INTEGER) AND rowid<=CAST(? AS INTEGER)";
    const page = `SELECT rowid FROM ${table}${seek} ORDER BY rowid LIMIT 1`;
    const args = after === null ? [] : [after, through];
    // Force outer mutations to the selected rowids; the state index can otherwise scan
    // every queued job before applying the bounded IN predicate. NOT INDEXED retains rowid seeks.
    const selected = `rowid IN (${page})`;
    const results = dense(
      await db.batch([
        after === null
          ? db.prepare(`SELECT CAST(max(rowid) AS TEXT) AS ceiling FROM ${table}`)
          : db.prepare("SELECT ? AS ceiling").bind(through),
        db
          .prepare(`SELECT count(*) AS examined,CAST(max(rowid) AS TEXT) AS last FROM (${page})`)
          .bind(...args),
        db
          .prepare(
            `UPDATE ${table} NOT INDEXED SET state='uncertain',payload=NULL,lease_token=NULL,lease_until=NULL
        WHERE ${selected} AND state='attempting' AND lease_until<=?`,
          )
          .bind(...args, at),
        db.prepare("SELECT changes() AS changed"),
        db
          .prepare(
            `UPDATE ${table} NOT INDEXED SET state='cancelled',payload=NULL,lease_token=NULL,lease_until=NULL
        WHERE ${selected} AND state IN ('queued','leased') AND expires_at<=?`,
          )
          .bind(...args, at),
        db.prepare("SELECT changes() AS changed"),
        db
          .prepare(`DELETE FROM ${table} NOT INDEXED WHERE ${selected} AND created<=?`)
          .bind(...args, cutoff),
        db.prepare("SELECT changes() AS changed"),
      ]),
      8,
    );
    if (results.length !== 8) return unavailable();
    const parsed = results.map(receipt),
      [upper, read] = parsed;
    if (
      upper.changes !== 0 ||
      upper.rows.length !== 1 ||
      read.changes !== 0 ||
      read.rows.length !== 1
    )
      return unavailable();
    const ceiling = record(upper.rows[0]);
    if (
      Object.keys(ceiling).join() !== "ceiling" ||
      (through !== null && ceiling.ceiling !== through)
    )
      return unavailable();
    through = ceiling.ceiling;
    const high = through === null ? null : rowid(through);
    const snapshot = record(read.rows[0]),
      { examined, last } = snapshot;
    if (Object.keys(snapshot).sort().join() !== "examined,last" || ![0, 1].includes(examined))
      return unavailable();
    const previous = last === null ? null : rowid(last);
    if (
      (examined === 0) !== (previous === null) ||
      (previous !== null &&
        (high === null || previous > high || (after !== null && previous <= rowid(after)))) ||
      (after === null && high !== null && examined === 0)
    )
      return unavailable();
    const counts = [];
    for (const [offset, multiplier] of [
      [2, 32770],
      [4, 2],
      [6, 2],
    ]) {
      const write = parsed[offset],
        counter = parsed[offset + 1];
      if (write.rows.length || counter.changes !== 0 || counter.rows.length !== 1)
        return unavailable();
      const value = record(counter.rows[0]),
        changed = value.changed;
      if (
        Object.keys(value).join() !== "changed" ||
        !Number.isSafeInteger(changed) ||
        changed < 0 ||
        changed > examined ||
        write.changes < changed ||
        write.changes > changed * multiplier
      )
        return unavailable();
      counts.push(changed);
    }
    const [uncertain, cancelled, removed] = counts;
    if (uncertain + cancelled > examined) return unavailable();
    const complete = examined === 0 || previous === high;
    return {
      status: "maintained",
      examined,
      uncertain,
      cancelled,
      removed,
      complete,
      next: complete ? null : { kind, after: previous.toString(), through },
    };
  } catch {
    // A commit may be unknown. Stop without retry or a certified continuation.
    return unavailable();
  }
}
