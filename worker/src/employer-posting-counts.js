// Dormant core: no production caller, catalog fetch, migration or shared limiter.
export const EMPLOYER_POSTING_EVENT = "employer_posting_open";
const DAY = 86_400_000;
const encoder = new TextEncoder();
const validKey = (key) =>
  typeof key === "string" &&
  key.length > 0 &&
  key === key.trim() &&
  !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(key) &&
  encoder.encode(key).length <= 200;
const instant = (now) => now instanceof Date && Number.isFinite(now.getTime());

// Copy, validate and hide the membership set; callers cannot mutate it after validation.
function catalog(keys) {
  if (!Array.isArray(keys) || !keys.length || keys.length > 10_000) return null;
  const members = new Set();
  for (const key of keys) {
    if (!validKey(key) || members.has(key)) return null;
    members.add(key);
  }
  return (key) => members.has(key);
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

// Time, validated catalog and DB are injected. No cache lifetime is chosen here.
// A caller must run cleanup successfully for the current UTC day before accepting counts.
export function createEmployerPostingCounter({ db, keys, now = () => new Date() }) {
  const known = catalog(keys);
  let readyDay = null;
  let cleanupVersion = 0;
  return {
    async cleanup() {
      const version = ++cleanupVersion;
      readyDay = null;
      const at = now();
      if (!known || !instant(at)) return false;
      const day = at.toISOString().slice(0, 10);
      const cutoff = new Date(at.getTime() - 90 * DAY).toISOString().slice(0, 10);
      try {
        const result = await db
          .prepare("DELETE FROM employer_posting_counts WHERE day < ?")
          .bind(cutoff)
          .run();
        const finished = now();
        if (
          !result.success ||
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
      if (!known || !instant(at)) return false;
      const day = at.toISOString().slice(0, 10);
      if (readyDay !== day || !employerMinuteBudget(address, at)) return false;
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).length !== 2 ||
        !Object.hasOwn(body, "e") ||
        !Object.hasOwn(body, "c") ||
        body.e !== EMPLOYER_POSTING_EVENT ||
        !validKey(body.c) ||
        !known(body.c)
      )
        return false;
      // One SQLite statement checks both caps and increments one. Concurrent requests
      // cannot pass a detached SELECT then overshoot. No persisted IP or global rollup.
      try {
        const result = await db
          .prepare(
            `
          INSERT INTO employer_posting_counts(day, company, n)
          SELECT ?, ?, 1
          WHERE COALESCE((SELECT SUM(n) FROM employer_posting_counts WHERE day = ?), 0) < 50000
            AND COALESCE((SELECT n FROM employer_posting_counts WHERE day = ? AND company = ?), 0) < 1000
          ON CONFLICT(day, company) DO UPDATE SET n = n + 1 WHERE n < 1000
        `,
          )
          .bind(day, body.c, day, day, body.c)
          .run();
        return result.success && result.meta.changes === 1;
      } catch {
        readyDay = null;
        return false;
      }
    },
  };
}
