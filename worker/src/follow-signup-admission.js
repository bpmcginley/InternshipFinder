import { requestLinkedFollowConfirmation } from "./follow-linked-request.js";
import { canonicalFollow, normalizeFollowEmail, requestFollowConfirmation } from "./follows.js";
import { bumpUnder } from "./limits.js";

// Fixed anonymous sentinel cannot collide with account SHA-256 IDs or the AI '*' sentinel.
const RATE_KEY = "*follow-signup";
const uuid = (value) =>
  typeof value === "string" && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const result = (status) => ({ status });
const unavailable = () => result("unavailable");
const sessionHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function copySessionProof(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "id,user"
  )
    return null;
  const { id, user } = value;
  return sessionHash(id) && sessionHash(user) ? { id, user } : null;
}

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
  let snapshot, email, scopeKey, session;
  const guarded = Object.hasOwn(options, "catalogExpiresAtMs"),
    cutoff = options.catalogExpiresAtMs;
  try {
    if (!Number.isSafeInteger(dailyLimit) || dailyLimit <= 0 || typeof clock !== "function")
      return unavailable();
    if (guarded && (!Number.isSafeInteger(cutoff) || cutoff <= 0)) return unavailable();
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
    if (input.link) {
      // The request body cannot supply proof. Snapshot the trusted caller's exact pair before I/O.
      session = copySessionProof(options.sessionProof);
      if (!session) return result("unsupported");
    }
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
        // Check the trusted pin at batch admission, before any queue mutation. A failed
        // guard aborts the whole D1 batch. Once admitted, preserve its atomic completion.
        const submitted = guarded
          ? [
              db
                .prepare("INSERT INTO follow_catalog_admissions(expires_at_ms) VALUES(?)")
                .bind(cutoff),
              ...statements,
            ]
          : statements;
        let rows = await db.batch(submitted);
        if (!Array.isArray(rows) || rows.length !== submitted.length) throw new Error();
        for (let index = 0; index < submitted.length; index++)
          if (!Object.hasOwn(rows, index) || rows[index]?.success !== true) throw new Error();
        if (guarded) {
          const guard = rows[0];
          if (guard.meta?.changes !== 0 || !Array.isArray(guard.results) || guard.results.length)
            throw new Error();
          rows = rows.slice(1); // Existing queue helpers receive their unchanged receipts.
        }
        const results = rows.at(-1).results;
        if (!Array.isArray(results) || results.length > 1) throw new Error();
        if (!results.length && session) return rows;
        if (!Object.hasOwn(results, 0)) throw new Error();
        const row = results[0];
        // The linked helper validates its own exact row fields. Reject holes and null rows here
        // so a malformed acknowledgement cannot be mistaken for its legitimate empty result.
        if (session) {
          if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error();
          return rows;
        }
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
    const scope = JSON.parse(scopeKey);
    const receipt = session
      ? await requestLinkedFollowConfirmation(queueDB, email, scope, snapshot, session)
      : await requestFollowConfirmation(queueDB, email, scope, snapshot, now);
    if (session && receipt === null) return result("accepted");
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
