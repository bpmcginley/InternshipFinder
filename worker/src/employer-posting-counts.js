// Dormant core: no production caller, URL, migration or shared limiter.
import {
  createEmployerCatalogCache,
  createRequestSafeEmployerCatalogCache,
} from "./employer-catalog-cache.js";

export const EMPLOYER_POSTING_EVENT = "employer_posting_open";
export const employerPostingCountsEnabled = (env) => env?.EMPLOYER_POSTING_COUNTS_ENABLED === "1";
const DAY = 86_400_000;
const encoder = new TextEncoder();
export const isEmployerPostingKey = (key) =>
  typeof key === "string" &&
  key.length > 0 &&
  key.length <= 200 &&
  key === key.trim() &&
  !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(key) &&
  encoder.encode(key).length <= 200;
const instant = (now) => now instanceof Date && Number.isFinite(now.getTime());

// Copy, validate and hide the membership set; callers cannot mutate it after validation.
function catalog(keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 10_000) return null;
  const members = new Set();
  for (const key of keys) {
    if (!isEmployerPostingKey(key) || members.has(key)) return null;
    members.add(key);
  }
  return (key) => members.has(key);
}

function parseCatalog(text) {
  return catalog(JSON.parse(text));
}

export function createEmployerMinuteBudget(schedule = setTimeout, cancel = clearTimeout) {
  let timer;
  let minute = null;
  let addresses = new Map();
  return (address, now) => {
    if (!instant(now) || typeof address !== "string" || !/^[0-9a-f:.]{1,64}$/i.test(address))
      return false;
    const current = Math.floor(now.getTime() / 60_000);
    if (current !== minute) {
      minute = current;
      addresses = new Map();
      cancel(timer);
      timer = schedule(
        () => {
          addresses.clear();
          minute = null;
        },
        60_000 - (now.getTime() % 60_000),
      );
      timer?.unref?.(); // Node tests must not wait for the otherwise-idle expiry timer.
    }
    const n = addresses.get(address) || 0;
    if ((!n && addresses.size >= 2_000) || n >= 30) return false;
    addresses.set(address, n + 1);
    return true;
  };
}

// Shared by counter instances in this isolate, including after snapshot replacement.
const employerMinuteBudget = createEmployerMinuteBudget();
const permanentMatch = () => true;
const validBody = (body) =>
  body &&
  typeof body === "object" &&
  !Array.isArray(body) &&
  Object.keys(body).length === 2 &&
  Object.hasOwn(body, "e") &&
  Object.hasOwn(body, "c") &&
  body.e === EMPLOYER_POSTING_EVENT &&
  isEmployerPostingKey(body.c);

// A server-only, single-use receipt: no IP, request, binding or persistent identifier.
const admissions = new WeakMap();
export function admitEmployerPosting(body, address, at) {
  if (!validBody(body) || !employerMinuteBudget(address, at)) return null;
  const receipt = Object.freeze({});
  admissions.set(receipt, { company: body.c, at: at.getTime() });
  return receipt;
}

export function createEmployerPostingCounter({ db, keys, now = () => new Date() }) {
  const known = catalog(keys);
  const match = known && ((key) => (known(key) ? permanentMatch : null));
  return employerPostingCounter(db, match, now);
}

export function createCachedEmployerPostingCounter({ db, load, maxBytes, now = () => new Date() }) {
  const cache = createEmployerCatalogCache({
    load,
    parse: parseCatalog,
    maxBytes,
    now: () => now().getTime(),
    loadTimeoutMs: 5_000,
  });
  return employerPostingCounter(db, cache.match, now);
}

// Only this parsed catalog may be shared across requests. No loader or D1 binding is retained.
export function createRequestSafeEmployerPostingCatalog({ maxBytes, now = Date.now }) {
  return createRequestSafeEmployerCatalogCache({ parse: parseCatalog, maxBytes, now });
}

// Construct inside the owning request; the caller still owns retention/health sequencing.
export function createRequestScopedEmployerPostingCounter({
  db,
  cache,
  load,
  now = () => new Date(),
}) {
  return employerPostingCounter(db, (key) => cache.match(key, load), now);
}

// Cleanup has to succeed for the current UTC day before accepting counts.
function employerPostingCounter(db, match, now) {
  let readyDay = null;
  let cleanupVersion = 0;
  return {
    async cleanup() {
      const version = ++cleanupVersion;
      readyDay = null;
      const at = now();
      if (!match || !instant(at)) return false;
      const day = at.toISOString().slice(0, 10);
      const cutoff = new Date(at.getTime() - 90 * DAY).toISOString().slice(0, 10);
      try {
        const results = await db.batch([
          db.prepare("DELETE FROM employer_posting_counts WHERE day < ?").bind(cutoff),
          db.prepare("DELETE FROM employer_posting_day_caps WHERE day < ?").bind(day),
          // Never reconstruct an active cap from counts that an owner may have deleted.
          // Existing history without its cap is ambiguous: stay off until operator recovery
          // or the next empty UTC day. Existing caps survive cleanup and process restarts.
          db
            .prepare(
              `INSERT INTO employer_posting_day_caps(day, n)
            SELECT ?, 0 WHERE NOT EXISTS (SELECT 1 FROM employer_posting_counts WHERE day = ?)
              AND NOT EXISTS (SELECT 1 FROM employer_posting_day_caps WHERE day > ?)
            ON CONFLICT(day) DO NOTHING`,
            )
            .bind(day, day, day),
          db.prepare("SELECT 1 AS ready FROM employer_posting_day_caps WHERE day = ?").bind(day),
        ]);
        const finished = now();
        if (
          !results.every((result) => result.success) ||
          results[3].results.length !== 1 ||
          version !== cleanupVersion ||
          !instant(finished) ||
          finished.toISOString().slice(0, 10) !== day
        )
          return false;
        readyDay = day;
        return true;
      } catch {
        return false;
      }
    },
    async count(body, address) {
      const at = now();
      if (
        !match ||
        !instant(at) ||
        readyDay !== at.toISOString().slice(0, 10) ||
        !employerMinuteBudget(address, at) ||
        !validBody(body)
      )
        return false;
      return countKnown(body.c, at);
    },
    async countAdmitted(admission) {
      const value = admissions.get(admission);
      admissions.delete(admission); // Consume before any await or caller-controlled operation.
      if (!value) return false;
      const fresh = now();
      if (
        !value ||
        !instant(fresh) ||
        fresh.getTime() < value.at ||
        fresh.toISOString().slice(0, 10) !== new Date(value.at).toISOString().slice(0, 10)
      )
        return false;
      return countKnown(value.company, new Date(value.at));
    },
  };
  async function countKnown(company, at) {
    const day = at.toISOString().slice(0, 10),
      version = cleanupVersion;
    if (!match || readyDay !== day) return false;
    const isCurrent = await match(company);
    if (!isCurrent) return false;
    const checked = now();
    const checkedTime = instant(checked) ? checked.getTime() : NaN;
    if (
      !isCurrent(checkedTime) ||
      !Number.isFinite(checkedTime) ||
      checkedTime < at.getTime() ||
      checked.toISOString().slice(0, 10) !== day ||
      readyDay !== day ||
      cleanupVersion !== version
    )
      return false;
    // D1 batch is one transaction. The second write follows only a successful company
    // increment; failure rolls both back. No full-day scan, IP, or historical rollup.
    try {
      const results = await db.batch([
        db
          .prepare(
            `
          INSERT INTO employer_posting_counts(day, company, n)
          SELECT ?, ?, 1
          WHERE (SELECT n FROM employer_posting_day_caps WHERE day = ?) < 50000
          ON CONFLICT(day, company) DO UPDATE SET n = n + 1 WHERE n < 1000
        `,
          )
          .bind(day, company, day),
        db
          .prepare("UPDATE employer_posting_day_caps SET n = n + 1 WHERE day = ? AND changes() = 1")
          .bind(day),
      ]);
      if (!results.every((result) => result.success)) {
        readyDay = null;
        return false;
      }
      return results.every((result) => result.meta.changes === 1);
    } catch {
      readyDay = null;
      return false;
    }
  }
}
