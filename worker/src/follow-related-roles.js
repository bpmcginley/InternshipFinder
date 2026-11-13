// Dormant pure selection. The caller owns snapshot verification, eligibility and freshness.
import { followInstant } from "./follow-matching.js";

const encoder = new TextEncoder();
const invalid = (reason) => ({ status: "invalid", reason });
const fields =
  "apply_url,company_key,company_name,field_tags,first_seen,id,location,states,status,title";
const text = (s, limit) =>
  typeof s === "string" &&
  s.length > 0 &&
  s.length <= limit &&
  s === s.trim() &&
  !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(s);
const tags = (values) =>
  Array.isArray(values) &&
  values.length <= 64 &&
  new Set(values).size === values.length &&
  [...values].every((s) => text(s, 200));
function posting(value) {
  if (!text(value, 2000) || /[\s<>"\\]/.test(value) || !/^https?:\/\/[^/]/i.test(value))
    return null;
  try {
    const url = new URL(value);
    if (!url.hostname || /^https?:\/\/[^/?#]*@/i.test(value) || url.href.length > 2000) return null;
    // Exact identity used by follow-mail roleLines; query remains significant.
    return url.origin + url.pathname + url.search;
  } catch {
    return null;
  }
}
const overlap = (values, set) => values.reduce((n, value) => n + Number(set.has(value)), 0);
const compareTuple = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const better = (a, b) =>
  compareTuple(a.score, b.score) > 0 ||
  (compareTuple(a.score, b.score) === 0 &&
    (a.at > b.at || (a.at === b.at && a.role.id < b.role.id)));

// Direct roles must be the actual already-deduplicated objects in this same verified snapshot.
// Explicit trusted limits are technical bounds, not production selection defaults.
export function selectFollowRelatedRoles(roles, direct, limits) {
  if (
    !limits ||
    !["maxRoles", "maxDirect", "maxPairs", "maxInputBytes", "maxResultBytes"].every(
      (k) => Number.isSafeInteger(limits[k]) && limits[k] > 0,
    )
  )
    return invalid("limits");
  if (
    !Array.isArray(roles) ||
    roles.length > limits.maxRoles ||
    !Array.isArray(direct) ||
    direct.length > limits.maxDirect ||
    (direct.length && roles.length > Math.floor(limits.maxPairs / direct.length))
  )
    return invalid("work_bound");
  const byId = new Map(),
    facts = [];
  let inputBytes = 2;
  for (const role of roles) {
    if (
      !role ||
      Object.keys(role).sort().join(",") !== fields ||
      typeof role.id !== "string" ||
      !/^[a-f0-9]{16}$/.test(role.id) ||
      byId.has(role.id) ||
      role.status !== "open" ||
      !text(role.company_key, 200) ||
      !text(role.company_name, 200) ||
      !text(role.title, 300) ||
      !text(role.location, 300) ||
      !tags(role.field_tags) ||
      !tags(role.states)
    )
      return invalid("role");
    const url = posting(role.apply_url),
      at = followInstant(role.first_seen);
    if (url === null || at === null) return invalid("role");
    // All strings/arrays are bounded above before serialization; no whole-snapshot allocation.
    inputBytes += encoder.encode(JSON.stringify(role)).length + (facts.length ? 1 : 0);
    if (inputBytes > limits.maxInputBytes) return invalid("input_bound");
    const fact = { role, url, at, fields: new Set(role.field_tags), states: new Set(role.states) };
    byId.set(role.id, fact);
    facts.push(fact);
  }
  if (inputBytes > limits.maxInputBytes) return invalid("input_bound");
  const ids = new Set(),
    urls = new Set(),
    seeds = [];
  for (const role of direct) {
    const fact = byId.get(role?.id);
    if (!fact || fact.role !== role || ids.has(role.id) || urls.has(fact.url))
      return invalid("direct");
    ids.add(role.id);
    urls.add(fact.url);
    seeds.push(fact);
  }
  const best = [];
  for (const fact of facts) {
    if (!seeds.length || ids.has(fact.role.id) || urls.has(fact.url)) continue;
    let score = [0, 0, 0];
    for (const seed of seeds) {
      const candidate = [
        Number(fact.role.company_key === seed.role.company_key),
        overlap(fact.role.field_tags, seed.fields),
        overlap(fact.role.states, seed.states),
      ];
      // A state alone is never a relationship. Use one best seed, not pooled scores.
      if ((candidate[0] || candidate[1]) && compareTuple(candidate, score) > 0) score = candidate;
    }
    if (!score[0] && !score[1]) continue;
    const candidate = { ...fact, score };
    const same = best.findIndex((entry) => entry.url === fact.url);
    if (same !== -1) {
      if (!better(candidate, best[same])) continue;
      best.splice(same, 1);
    }
    const index = best.findIndex((entry) => better(candidate, entry));
    best.splice(index === -1 ? best.length : index, 0, candidate);
    if (best.length > 2) best.pop();
  }
  const result = { status: "selected", similar: best.map((entry) => entry.role) };
  return encoder.encode(JSON.stringify(result)).length <= limits.maxResultBytes
    ? result
    : invalid("result_bound");
}
