// Dormant send-free scan. The caller resumes each kind and resets after a complete pass.
const unavailable = () => ({ status: "unavailable" });
const definitions = Object.freeze({
  "digest-days": {
    table: "follow_digest_days",
    expired: "expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    multiplier: 1,
  },
  confirmation: {
    table: "follow_confirmation_outbox",
    expired: "expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    multiplier: 2,
  },
  tokens: {
    table: "follow_tokens",
    expired:
      "(expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') OR (purpose='confirm' AND EXISTS " +
      "(SELECT 1 FROM follow_subscriptions s WHERE s.subscriber_id=follow_tokens.subscriber_id " +
      "AND s.scope_key=follow_tokens.scope_key AND s.confirmed_at IS NULL " +
      "AND s.created<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days'))))",
    multiplier: 4,
  },
});
function record(value) {
  if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw Error();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (
    Object.getOwnPropertySymbols(value).length ||
    Object.values(fields).some((f) => !f.enumerable || !Object.hasOwn(f, "value"))
  )
    throw Error();
  return Object.assign(
    Object.create(null),
    Object.fromEntries(Object.entries(fields).map(([k, f]) => [k, f.value])),
  );
}
function rowid(value) {
  if (typeof value !== "string" || !/^(0|-?[1-9]\d{0,18})$/.test(value)) throw Error();
  const n = BigInt(value);
  if (n < -9223372036854775808n || n > 9223372036854775807n) throw Error();
  return n;
}
function dense(value, max) {
  if (!Array.isArray(value)) throw Error();
  const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > max) throw Error();
  const copy = [];
  for (let i = 0; i < length; i++) {
    const f = Object.getOwnPropertyDescriptor(value, i);
    if (!f?.enumerable || !Object.hasOwn(f, "value")) throw Error();
    copy.push(f.value);
  }
  return copy;
}
function receipt(value) {
  const r = record(value),
    meta = record(r.meta);
  if (r.success !== true || !Number.isSafeInteger(meta.changes) || meta.changes < 0) throw Error();
  return { rows: dense(r.results, 128), changes: meta.changes };
}

// Internal shared validation; descriptors are copied once before any values are used.
export const expiryReceipts = Object.freeze({ record, rowid, dense, receipt });

export async function expireFollowPage(db, options = {}) {
  try {
    const o = record(options);
    if (o.enabled !== true) return { status: "disabled" };
    const { kind, cursor = null, maxRows } = o;
    if (
      typeof kind !== "string" ||
      !Object.hasOwn(definitions, kind) ||
      !Number.isSafeInteger(maxRows) ||
      maxRows < 1 ||
      maxRows > 128
    )
      return unavailable();
    if (Object.keys(o).some((k) => !["enabled", "kind", "cursor", "maxRows"].includes(k)))
      return unavailable();
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
    const { table, expired, multiplier } = definitions[kind];
    const ceiling = `SELECT CAST(max(rowid) AS TEXT) AS ceiling FROM ${table}`;
    const seek =
      after === null
        ? ` WHERE rowid<=(SELECT max(rowid) FROM ${table})`
        : " WHERE rowid>CAST(? AS INTEGER) AND rowid<=CAST(? AS INTEGER)";
    const page = `SELECT rowid FROM ${table}${seek} ORDER BY rowid LIMIT ?`;
    const args = after === null ? [maxRows] : [after, through, maxRows];
    // D1 batch serializes the page read and deletion. Only the deletion samples expiry.
    const result = dense(
      await db.batch([
        after === null ? db.prepare(ceiling) : db.prepare("SELECT ? AS ceiling").bind(through),
        db
          .prepare(`SELECT count(*) AS examined,CAST(max(rowid) AS TEXT) AS last FROM (${page})`)
          .bind(...args),
        db.prepare(`DELETE FROM ${table} WHERE rowid IN (${page}) AND ${expired}`).bind(...args),
        db.prepare("SELECT changes() AS removed"),
      ]),
      4,
    );
    if (result.length !== 4) return unavailable();
    const upper = receipt(result[0]),
      read = receipt(result[1]),
      write = receipt(result[2]),
      count = receipt(result[3]);
    if (
      upper.changes !== 0 ||
      upper.rows.length !== 1 ||
      read.changes !== 0 ||
      count.changes !== 0 ||
      write.rows.length ||
      read.rows.length !== 1 ||
      count.rows.length !== 1
    )
      return unavailable();
    const bound = record(upper.rows[0]);
    if (Object.keys(bound).join() !== "ceiling") return unavailable();
    if (through !== null && bound.ceiling !== through) return unavailable();
    through = bound.ceiling;
    const high = through === null ? null : rowid(through);
    const pageReceipt = record(read.rows[0]);
    const { examined, last } = pageReceipt;
    if (
      Object.keys(pageReceipt).sort().join() !== "examined,last" ||
      !Number.isSafeInteger(examined) ||
      examined < 0 ||
      examined > maxRows
    )
      return unavailable();
    const previous = last === null ? null : rowid(last);
    if (
      (examined === 0) !== (previous === null) ||
      (previous !== null &&
        (high === null || previous > high || (after !== null && previous <= rowid(after)))) ||
      (after === null &&
        high !== null &&
        (examined === 0 || (examined < maxRows && previous !== high)))
    )
      return unavailable();
    const direct = record(count.rows[0]);
    const removed = direct.removed;
    if (
      Object.keys(direct).join() !== "removed" ||
      !Number.isSafeInteger(removed) ||
      removed < 0 ||
      removed > examined ||
      write.changes < removed ||
      write.changes > removed * multiplier
    )
      return unavailable();
    const complete = examined < maxRows || previous === high;
    return {
      status: "maintained",
      examined,
      removed,
      complete,
      next: complete ? null : { kind, after: previous.toString(), through },
    };
  } catch {
    // A write may have committed. No retry or cursor is certified after an uncertain receipt.
    return unavailable();
  }
}
