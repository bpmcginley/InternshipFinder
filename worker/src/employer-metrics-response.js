import { employerMetrics } from "./employer-metrics.js";
import { employerPostingCountsEnabled } from "./employer-posting-counts.js";
import { readEmployerPostingReport } from "./employer-posting-report.js";
import { HttpError, json } from "./http.js";

const noStore = { "Cache-Control": "no-store" };
const encoder = new TextEncoder();
const about =
  "At most one organic posting-link activation per company per page load. Reloads can count again. " +
  "These are not unique people, applications, or verified arrivals. Counts may omit blocked or dropped events.";
const invalidCursor = () =>
  new HttpError(400, "organic_after", "Invalid employer posting report cursor");

function organicCursor(query) {
  const values = query.getAll("organic_after");
  if (!values.length) return null;
  const value = values[0];
  if (values.length !== 1 || value.length > 1024 || encoder.encode(value).length > 1024)
    throw invalidCursor();
  let after;
  try {
    after = JSON.parse(value);
  } catch {
    throw invalidCursor();
  }
  if (!after || Object.keys(after).sort().join(",") !== "company,day,end_exclusive,start")
    throw invalidCursor();
  return after;
}

// Bind this handler only inside the existing owner-only withAdmin route wrapper.
export async function employerMetricsResponse({ request, env, db, now }) {
  const query = new URL(request.url).searchParams;
  const days = Number(query.get("days") || 28);
  const reportNow = new Date(now.getTime());
  const enabled = employerPostingCountsEnabled(env);
  const after = enabled ? organicCursor(query) : null;
  const report = await employerMetrics(db, days, reportNow);
  if (enabled) {
    try {
      report.organic_posting_counts = {
        status: "available",
        ...(await readEmployerPostingReport(db, days, reportNow, { after })),
        about,
      };
    } catch (error) {
      if (error instanceof RangeError && error.message === "Invalid employer posting report cursor")
        throw invalidCursor();
      // Preserve the existing funnel when the optional aggregate storage is unavailable.
      report.organic_posting_counts = { status: "unavailable" };
    }
  }
  return json(report, 200, noStore);
}
