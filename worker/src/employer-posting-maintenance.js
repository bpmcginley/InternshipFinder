// Dormant database maintenance. Scheduling and operator activation are separate.
const MAX_ROWS = 1000;
const state = (status) => ({ status });
const dayOf = (value) => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return null;
  const day = value.toISOString().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
};

// One invocation owns every promise/binding and performs at most one bounded batch.
// Callers may retry progress/unavailable; blocked requires a fresh clock or owner repair.
export async function maintainEmployerPostings(
  db,
  { enabled = false, now = () => new Date(), maxRows = MAX_ROWS } = {},
) {
  if (enabled !== true) return state("disabled");
  try {
    const started = now();
    const day = dayOf(started);
    const startedAt = started?.getTime();
    if (!day || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > MAX_ROWS)
      return state("blocked");
    const clock = await db.prepare("SELECT date('now') AS day").first();
    if (clock?.day !== day) return state("blocked");
    const results = await db.batch([
      db
        .prepare(
          `DELETE FROM employer_posting_counts
           WHERE ?=date('now')
             AND NOT EXISTS(SELECT 1 FROM employer_posting_counts WHERE day>?)
             AND NOT EXISTS(SELECT 1 FROM employer_posting_day_caps WHERE day>?)
             AND (day,company) IN (
             SELECT day,company FROM employer_posting_counts
             WHERE day<date(?,'-90 days') ORDER BY day,company LIMIT ?
           )`,
        )
        .bind(day, day, day, day, maxRows),
      db
        .prepare(
          `DELETE FROM employer_posting_day_caps
           WHERE ?=date('now')
             AND NOT EXISTS(SELECT 1 FROM employer_posting_counts WHERE day>?)
             AND NOT EXISTS(SELECT 1 FROM employer_posting_day_caps WHERE day>?)
             AND day IN (
             SELECT day FROM employer_posting_day_caps
             WHERE day<? ORDER BY day LIMIT ?
           )`,
        )
        .bind(day, day, day, day, maxRows),
      db
        .prepare(
          `INSERT INTO employer_posting_day_caps(day,n)
           SELECT ?,0 WHERE ?=date('now')
             AND NOT EXISTS(SELECT 1 FROM employer_posting_counts WHERE day=?)
             AND NOT EXISTS(SELECT 1 FROM employer_posting_counts WHERE day<date(?,'-90 days'))
             AND NOT EXISTS(SELECT 1 FROM employer_posting_day_caps WHERE day<?)
             AND NOT EXISTS(SELECT 1 FROM employer_posting_day_caps WHERE day>?)
             AND NOT EXISTS(SELECT 1 FROM employer_posting_counts WHERE day>?)
           ON CONFLICT(day) DO NOTHING`,
        )
        .bind(day, day, day, day, day, day, day),
      db
        .prepare(
          `SELECT date('now') AS day,
           EXISTS(SELECT 1 FROM employer_posting_counts WHERE day<date(?,'-90 days')) AS expired,
           EXISTS(SELECT 1 FROM employer_posting_day_caps WHERE day<?) AS old_caps,
           EXISTS(SELECT 1 FROM employer_posting_day_caps WHERE day>?) AS future_caps,
           EXISTS(SELECT 1 FROM employer_posting_counts WHERE day>?) AS future_counts,
           EXISTS(SELECT 1 FROM employer_posting_day_caps WHERE day=?) AS current_cap`,
        )
        .bind(day, day, day, day, day),
    ]);
    if (
      results.length !== 4 ||
      !results.every((result) => result.success === true) ||
      results
        .slice(0, 3)
        .some(
          (result, index) =>
            !Number.isInteger(result.meta?.changes) ||
            result.meta.changes < 0 ||
            result.meta.changes > (index === 2 ? 1 : maxRows),
        ) ||
      results[3].results?.length !== 1
    )
      return state("unavailable");
    const health = results[3].results[0];
    const finished = now();
    if (health.day !== day || dayOf(finished) !== day || finished.getTime() < startedAt)
      return state("blocked");
    if (
      ![
        health.expired,
        health.old_caps,
        health.future_caps,
        health.future_counts,
        health.current_cap,
      ].every((value) => value === 0 || value === 1)
    )
      return state("unavailable");
    if (health.future_caps || health.future_counts) return state("blocked");
    if (health.expired || health.old_caps) return state("progress");
    return state(health.current_cap ? "ready" : "blocked");
  } catch {
    return state("unavailable");
  }
}
