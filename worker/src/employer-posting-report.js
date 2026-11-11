// Dormant owner-report query. The route must authorize the owner and send no-store.
const DAY = 86_400_000;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAGE = 1000;
const encoder = new TextEncoder();
const isDateKey = (day) => {
  if (typeof day !== "string" || !DATE_KEY.test(day)) return false;
  const stamp = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(stamp.getTime()) && stamp.toISOString().slice(0, 10) === day;
};

export async function readEmployerPostingReport(
  db,
  days,
  now,
  { after = null, limit = MAX_PAGE } = {},
) {
  if (
    !Number.isInteger(days) ||
    days < 1 ||
    days > 90 ||
    !(now instanceof Date) ||
    !Number.isFinite(now.getTime()) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_PAGE
  )
    throw new RangeError("Invalid employer posting report window");

  const end = now.toISOString().slice(0, 10);
  if (!DATE_KEY.test(end)) throw new RangeError("Invalid employer posting report window");
  const start = new Date(Date.parse(`${end}T00:00:00Z`) - days * DAY).toISOString().slice(0, 10);
  if (!DATE_KEY.test(start)) throw new RangeError("Invalid employer posting report window");
  if (
    after !== null &&
    (after?.start !== start ||
      after.end_exclusive !== end ||
      !isDateKey(after.day) ||
      after.day < start ||
      after.day >= end ||
      typeof after.company !== "string" ||
      !after.company ||
      after.company.length > 200 ||
      encoder.encode(after.company).length > 200)
  )
    throw new RangeError("Invalid employer posting report cursor");

  // A keyset keeps later pages bounded without returning the abuse-control total.
  const { results } = await db
    .prepare(
      "SELECT day, company, n FROM employer_posting_counts " +
        "WHERE (day, company) > (?, ?) AND day < ? " +
        "ORDER BY day, company LIMIT ?",
    )
    .bind(after?.day ?? start, after?.company ?? "", end, limit + 1)
    .all();
  const rows = results.slice(0, limit);
  const last = rows.at(-1);
  return {
    start,
    end_exclusive: end,
    rows,
    next:
      results.length > limit
        ? { start, end_exclusive: end, day: last.day, company: last.company }
        : null,
  };
}
