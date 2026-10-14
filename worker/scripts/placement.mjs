#!/usr/bin/env node
// Paid listings from Bruce's own terminal (added 2026-10-14). Wraps the Worker's /admin/placements
// routes (src/placements.js, API.md "Placements"). No dependencies; Node 20+.
//
// The admin token is read from the INTERNSCOUT_ADMIN_TOKEN environment variable on this machine, the
// same value as the Worker's ADMIN_TOKEN secret. This script never prints it, never takes it as an
// argument (arguments end up in shell history) and only sends it over https (or to localhost for
// `wrangler dev`). What it prints leaves out paid_ref, so a pasted output does not carry invoice numbers.
//
//   node scripts/placement.mjs list
//   node scripts/placement.mjs leads
//   node scripts/placement.mjs live
//   node scripts/placement.mjs create --lead 12 --listing 3f9c0a1b2c3d4e5f --url https://... --start 2026-11-01 --end 2026-12-01 --by bruce
//   node scripts/placement.mjs update <id> [--start D] [--end D] [--listing ID] [--url URL] [--employer NAME] [--note TEXT] --by bruce
//   node scripts/placement.mjs check <id> --checks role_on_employer_site,email_domain,... [--unpaid-ok] --by bruce
//   node scripts/placement.mjs on <id> --ref <invoice number or pilot> --by bruce
//   node scripts/placement.mjs pause <id> --reason "..." --by bruce
//   node scripts/placement.mjs end <id> --reason removed --by bruce
//   node scripts/placement.mjs refuse <id> --reason "..." --by bruce
//
// INTERNSCOUT_API_URL overrides the Worker address (for example http://localhost:8787 with `wrangler dev`).
import { pathToFileURL } from "node:url";

export const DEFAULT_API = "https://internscout-api.bpmcginley.workers.dev";

export const USAGE = `Usage: node scripts/placement.mjs <command> [id] [--flags]

Commands:
  list                      every placement with its recent log (admin)
  leads                     recent employer leads: id, date, company, wants (admin; no contact details)
  live                      what GET /placements shows the site build today (public)
  create                    --listing ID --url URL --start YYYY-MM-DD --end YYYY-MM-DD
                            [--lead N] [--employer NAME] [--note TEXT]
  update <id>               [--start D] [--end D] [--listing ID] [--url URL] [--employer NAME] [--note TEXT]
  check <id>                --checks a,b,c [--unpaid-ok]
                            checks: role_on_employer_site, email_domain, pay_range_where_required,
                            paid_or_public_body, min_age_if_hs, not_hazardous_for_minors,
                            no_fee_no_early_data, no_targeting_asked
  on <id>                   --ref <invoice number or pilot>
  pause <id>                --reason TEXT
  end <id>                  --reason dates|role_closed|listing_gone|removed|refunded
  refuse <id>               --reason TEXT

Every change takes --by LABEL (default "bruce"). End is the first day it no longer shows.
Set INTERNSCOUT_ADMIN_TOKEN in your environment first; it is never printed.`;

const FLAGS = new Set(["lead", "listing", "url", "start", "end", "employer", "note", "checks", "ref", "reason", "by", "unpaid-ok"]);
const BOOLEAN = new Set(["unpaid-ok"]);

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) { positional.push(a); continue; }
    const name = a.slice(2);
    if (!FLAGS.has(name)) throw new Error(`Unknown flag --${name}`);
    if (BOOLEAN.has(name)) { flags[name] = true; continue; }
    if (i + 1 >= rest.length || rest[i + 1].startsWith("--")) throw new Error(`--${name} needs a value`);
    flags[name] = rest[++i];
  }
  return { cmd, id: positional[0], extra: positional.slice(1), flags };
}

// The HTTP call a command makes: { method, path, body?, admin }.
export function toRequest({ cmd, id, extra, flags }) {
  if (extra && extra.length) throw new Error(`Unexpected argument: ${extra[0]}`);
  const by = flags.by || "bruce";
  const need = (...names) => {
    for (const n of names) if (flags[n] == null) throw new Error(`${cmd} needs --${n}`);
  };
  const needId = () => {
    if (!id) throw new Error(`${cmd} needs the placement id, for example: ${cmd} p-2026-11-acme-1`);
  };
  const pick = (map) => Object.fromEntries(Object.entries(map).filter(([, v]) => v != null));
  switch (cmd) {
    case "list": return { method: "GET", path: "/admin/placements", admin: true };
    case "leads": return { method: "GET", path: "/admin/leads", admin: true };
    case "live": return { method: "GET", path: "/placements", admin: false };
    case "create": {
      need("listing", "url", "start", "end");
      let lead;
      if (flags.lead != null) {
        lead = Number(flags.lead);
        if (!Number.isSafeInteger(lead) || lead < 1) throw new Error("--lead must be a lead's id number");
      }
      return { method: "POST", path: "/admin/placements", admin: true, body: pick({
        lead_id: lead, employer: flags.employer, listing_id: flags.listing, apply_url: flags.url,
        start: flags.start, end: flags.end, note: flags.note, by }) };
    }
    case "update": {
      needId();
      return { method: "POST", path: "/admin/placements/update", admin: true, body: pick({
        id, by, start: flags.start, end: flags.end, listing_id: flags.listing, apply_url: flags.url,
        employer: flags.employer, note: flags.note }) };
    }
    case "check": {
      needId();
      need("checks");
      const checks = flags.checks.split(",").map((s) => s.trim()).filter(Boolean);
      return { method: "POST", path: "/admin/placements/check", admin: true,
        body: { id, by, checks, unpaid_ok: !!flags["unpaid-ok"] } };
    }
    case "on":
      needId();
      need("ref");
      return { method: "POST", path: "/admin/placements/on", admin: true, body: { id, by, paid_ref: flags.ref } };
    case "pause":
    case "end":
    case "refuse":
      needId();
      need("reason");
      return { method: "POST", path: `/admin/placements/${cmd}`, admin: true, body: { id, by, reason: flags.reason } };
    default:
      throw new Error(cmd ? `Unknown command: ${cmd}` : "No command given");
  }
}

// A copy without paid_ref anywhere in it (rows, and the before/after rows in their log).
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "paid_ref").map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

function apiBase(env) {
  const raw = (env.INTERNSCOUT_API_URL || DEFAULT_API).replace(/\/+$/, "");
  const u = new URL(raw);
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) {
    throw new Error("INTERNSCOUT_API_URL must be https:// (or http://localhost for wrangler dev)");
  }
  return raw;
}

// Runs one command. Returns the exit code; everything printed goes through `out` and `err`.
export async function run(argv, { env = process.env, fetch: f = fetch, out = console.log, err = console.error } = {}) {
  let req;
  try {
    if (!argv.length || argv[0] === "help" || argv[0] === "--help") { out(USAGE); return argv.length ? 0 : 2; }
    req = toRequest(parseArgs(argv));
  } catch (e) {
    err(`${e.message}\n\n${USAGE}`);
    return 2;
  }
  const token = env.INTERNSCOUT_ADMIN_TOKEN || "";
  if (req.admin && !token) {
    err("Set INTERNSCOUT_ADMIN_TOKEN in your environment first (the same value as the Worker's ADMIN_TOKEN secret).");
    return 2;
  }
  // Belt and braces: should any text ever echo the token back, it is masked before printing.
  const mask = (s) => (token ? String(s).split(token).join("[token]") : String(s));
  let res;
  try {
    const headers = {};
    // No Origin header: the Worker refuses any request that has one.
    if (req.admin) headers.Authorization = `Bearer ${token}`;
    if (req.body) headers["Content-Type"] = "application/json";
    res = await f(apiBase(env) + req.path, { method: req.method, headers, body: req.body ? JSON.stringify(req.body) : undefined });
  } catch (e) {
    // Only the error's own message: it never holds the request headers.
    err(mask(`Could not reach the Worker: ${(e && e.message) || e}`));
    return 1;
  }
  let data;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const what = data && data.error ? `${data.error}: ${data.message || ""}` : "no details";
    err(mask(`HTTP ${res.status} (${what})`));
    if (res.status === 404 && req.admin) err("A 404 here can also mean ADMIN_TOKEN is not set on the Worker yet.");
    return 1;
  }
  out(mask(JSON.stringify(redact(data), null, 2)));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
