// Shared plumbing for the offline form benchmark: where its data files live, and the two small
// pieces of agent.js loop() that are not exported there (accountLine, and the facts fastFill gets).
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

globalThis.chrome = globalThis.chrome || { runtime: {}, storage: { local: {}, session: {} }, tabs: {}, scripting: {} };
await import("../../extension/agent/guard.js");   // hangs ISGuard off globalThis, as agent.js does
const { accountFor } = await import("../../extension/lib/store.js");

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, "..", "..");
// Git-ignored (scripts/eval/*.json): the fictional profile's answers and public postings only.
export const file = (name) => join(HERE, `bench-${name}.json`);
export const load = (name, d = null) => (existsSync(file(name)) ? JSON.parse(readFileSync(file(name), "utf8")) : d);
export const save = (name, v) => writeFileSync(file(name), JSON.stringify(v, null, 1));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const opt = (argv, k, d) => { const a = argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d; };

// agent.js accountLine (module-private there), word for word.
export function accountLine(store, url) {
  const a = accountFor(store, url);
  return a.isNew
    ? `ACCOUNT (${a.domain}): none saved. If an account is required, create one with email ${a.email}.`
    : `ACCOUNT (${a.domain}): exists. Sign in with email ${a.email}; use fill_secret for the password.`;
}

// What agent.js loop hands fastFill: the profile's facts, the sign-up email, and whether the job is in the US.
export function factsFor(store, job) {
  return { ...store.profile.facts, email: store.settings.signup_email || store.profile.facts.email, job_in_us: globalThis.ISGuard.jobInUS(job.location) };
}
