// The repository's clock (added 2026-10-01). GitHub's scheduled workflows are best effort, and for
// this repository most never start: on 2026-10-01 the hourly dashboard copy ran 3 times instead of 24,
// "Keep schedule" (every 30 minutes) 3 times instead of 48, and the 11am brand post not at all until
// it was started by hand at 3:52pm. Cloudflare's cron triggers do fire on time, so every half hour this
// starts "Keep schedule" (.github/workflows/catchup.yml) through workflow_dispatch, which GitHub runs at
// once. That workflow already knows what is overdue (growth/catchup.py) and starts it; a job that is
// on time or already running is left alone, so an extra start costs one short run and nothing else.
//
// Needs the GITHUB_DISPATCH_TOKEN secret: a fine-grained GitHub token for this one repository with
// only "Actions: Read and write". Without it this does nothing, and GitHub's own schedule is all there is.

export const CLOCK_CRON = "4,34 * * * *";       // wrangler.toml [triggers]; clear of the top of the hour
const DEFAULT_REPO = "bpmcginley/InternshipFinder";
const WORKFLOW = "catchup.yml";

export async function startCatchup(env, fetchImpl = fetch) {
  const token = env.GITHUB_DISPATCH_TOKEN;
  if (!token) return { started: false, why: "no GITHUB_DISPATCH_TOKEN" };
  const repo = env.GITHUB_REPO || DEFAULT_REPO;
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "internscout-api-clock",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: "main" }),
  });
  // 204 is success. Only the status is logged: never the token, and GitHub's error text can echo request details.
  if (res.status !== 204) {
    console.error("clock: starting Keep schedule failed with HTTP", res.status);
    return { started: false, why: `HTTP ${res.status}` };
  }
  return { started: true };
}
