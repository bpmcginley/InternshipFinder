// Dormant parsed-input boundary. No issuance, mail, route or production policy defaults.
import { normalizeFollowEmail } from "./follows.js";
import { bumpUnder } from "./limits.js";

const RATE_KEY = "*follow-management";
const MAX_TTL_MS = 7 * 86400000;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const result = (status) => ({ status });
const unavailable = () => result("unavailable");

function checkedBatch(rows, count) {
  if (!Array.isArray(rows) || rows.length !== count) throw new Error();
  for (let i = 0; i < count; i++)
    if (!Object.hasOwn(rows, i) || rows[i]?.success !== true) throw new Error();
  return rows;
}

function dayReceipt(receipt) {
  if (
    receipt.meta?.changes !== 0 ||
    !Array.isArray(receipt.results) ||
    receipt.results.length !== 1
  )
    throw new Error();
  const row = receipt.results[0];
  if (
    !row ||
    Array.isArray(row) ||
    Object.keys(row).join(",") !== "day" ||
    typeof row.day !== "string"
  )
    throw new Error();
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(row.day) ||
    new Date(row.day).toISOString() !== row.day + "T00:00:00.000Z"
  )
    throw new Error();
  return row.day;
}

function writeReceipt(receipt) {
  if (
    receipt?.success !== true ||
    ![0, 1].includes(receipt.meta?.changes) ||
    !Array.isArray(receipt.results) ||
    receipt.results.length !== 0
  )
    throw new Error();
}

export async function enqueueFollowManagementRequest(db, input, options = {}) {
  if (options?.enabled !== true) return result("disabled");
  const { ttlMs, dailyLimit } = options;
  if (
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > MAX_TTL_MS ||
    !Number.isSafeInteger(dailyLimit) ||
    dailyLimit < 1
  )
    return unavailable();
  let email;
  try {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).join(",") !== "email"
    )
      return result("invalid");
    email = normalizeFollowEmail(input.email);
  } catch {
    return result("invalid");
  }
  try {
    const clock = () => db.prepare("SELECT date('now') AS day");
    const day = dayReceipt(checkedBatch(await db.batch([clock()]), 1)[0]);
    const rateDB = {
      prepare: (sql) => ({
        bind: (...values) => ({
          run: async () => {
            const receipt = await db
              .prepare(sql)
              .bind(...values)
              .run();
            writeReceipt(receipt);
            return receipt;
          },
        }),
      }),
    };
    // All valid requests spend the same anonymous budget, including unknown/duplicate inboxes.
    if (!(await bumpUnder(rateDB, RATE_KEY, "d:" + day, dailyLimit))) return unavailable();
    const rows = checkedBatch(
      await db.batch([
        db
          .prepare(
            `INSERT INTO follow_management_outbox(id,subscriber_id,queued_at,expires_at)
         SELECT ?,u.id,${NOW},strftime('%Y-%m-%dT%H:%M:%fZ','now',?||' seconds')
         FROM follow_subscribers u WHERE u.email=? AND date('now')=?
           AND EXISTS(SELECT 1 FROM follow_subscriptions s WHERE s.subscriber_id=u.id)
         ON CONFLICT(subscriber_id) DO UPDATE SET id=excluded.id,
           queued_at=excluded.queued_at,expires_at=excluded.expires_at,claim_id=NULL
         WHERE follow_management_outbox.expires_at<=${NOW} RETURNING 1 AS changed`,
          )
          .bind(crypto.randomUUID(), ttlMs / 1000, email, day),
        clock(),
      ]),
      2,
    );
    // At most one returned constant proves direct upsert work, excluding cursor triggers.
    const write = rows[0];
    if (
      !Number.isSafeInteger(write.meta?.changes) ||
      write.meta.changes < 0 ||
      !Array.isArray(write.results) ||
      write.results.length > 1 ||
      write.meta.changes < write.results.length ||
      write.meta.changes - write.results.length > 1 ||
      (write.results.length === 0 && write.meta.changes !== 0) ||
      (write.results.length === 1 &&
        (!Object.hasOwn(write.results, 0) ||
          !write.results[0] ||
          Array.isArray(write.results[0]) ||
          Object.keys(write.results[0]).join(",") !== "changed" ||
          write.results[0].changed !== 1))
    )
      return unavailable();
    if (dayReceipt(rows[1]) !== day) return unavailable();
    return result("accepted");
  } catch {
    // A spent or uncertain attempt is never refunded or retried. Do not expose inbox state.
    return unavailable();
  }
}
