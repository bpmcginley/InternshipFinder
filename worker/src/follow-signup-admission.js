import { canonicalFollow, normalizeFollowEmail, requestFollowConfirmation } from "./follows.js";
import { bumpUnder } from "./limits.js";

// Fixed anonymous sentinel cannot collide with account SHA-256 IDs or the AI '*' sentinel.
const RATE_KEY = "*follow-signup";
const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const result = (status) => ({ status });
const unavailable = () => result("unavailable");
const instant = (clock) => {
  const value = clock();
  if (
    !(value instanceof Date) ||
    !Number.isFinite(value.getTime()) ||
    !/^\d{4}-/.test(value.toISOString())
  )
    throw new Error();
  return new Date(value.getTime());
};

// Internal parsed-input boundary, not HTTP parsing, signup activation or sending authority.
export async function admitFollowSignup(db, input, options = {}) {
  if (options?.enabled !== true) return result("disabled");
  const { dailyLimit, catalog, clock = () => new Date() } = options;
  let snapshot, email, scopeKey;
  try {
    if (!Number.isSafeInteger(dailyLimit) || dailyLimit <= 0 || typeof clock !== "function")
      return unavailable();
    snapshot = Object.fromEntries(
      ["companies", "fields", "states"].map((kind) => {
        if (!(catalog?.[kind] instanceof Set)) throw new Error();
        return [kind, new Set(catalog[kind])];
      }),
    );
  } catch {
    return unavailable();
  }
  try {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== "email,link,scope" ||
      typeof input.link !== "boolean"
    )
      return result("invalid");
    // Never downgrade a requested account link into an unlinked subscription.
    if (input.link) return result("unsupported");
    email = normalizeFollowEmail(input.email);
    scopeKey = canonicalFollow(input.scope, snapshot);
  } catch {
    return result("invalid");
  }
  try {
    const started = instant(clock),
      day = started.toISOString().slice(0, 10);
    // Validate explicit D1 success before allowing bumpUnder's boolean to authorize a write.
    const rateDB = {
      prepare: (sql) => ({
        bind: (...values) => ({
          run: async () => {
            const r = await db
              .prepare(sql)
              .bind(...values)
              .run();
            if (r?.success !== true || ![0, 1].includes(r.meta?.changes)) throw new Error();
            return r;
          },
        }),
      }),
    };
    if (!(await bumpUnder(rateDB, RATE_KEY, "d:" + day, dailyLimit))) return unavailable();
    const now = instant(clock);
    if (now < started || now.toISOString().slice(0, 10) !== day) return unavailable();
    const queueDB = {
      prepare: (sql) => db.prepare(sql),
      batch: async (statements) => {
        const rows = await db.batch(statements);
        if (!Array.isArray(rows) || rows.length !== statements.length) throw new Error();
        for (let index = 0; index < statements.length; index++)
          if (!Object.hasOwn(rows, index) || rows[index]?.success !== true) throw new Error();
        const results = rows.at(-1).results;
        if (!Array.isArray(results) || results.length !== 1 || !Object.hasOwn(results, 0))
          throw new Error();
        const row = results[0];
        if (
          !row ||
          typeof row !== "object" ||
          Array.isArray(row) ||
          Object.keys(row).sort().join(",") !== "id,job_id" ||
          !uuid(row.id) ||
          !(row.job_id === null || uuid(row.job_id))
        )
          throw new Error();
        return rows;
      },
    };
    const receipt = await requestFollowConfirmation(
      queueDB,
      email,
      JSON.parse(scopeKey),
      snapshot,
      now,
    );
    if (
      !uuid(receipt?.subscriberId) ||
      receipt.scopeKey !== scopeKey ||
      !(receipt.confirmationJobId === null || uuid(receipt.confirmationJobId))
    )
      return unavailable();
    return result("accepted");
  } catch {
    // An admitted attempt is never refunded or retried after uncertain storage outcomes.
    return unavailable();
  }
}
