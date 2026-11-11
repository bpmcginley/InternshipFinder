// Dormant draft producer contract. No fetch, clock, schema, watermark write or send caller.
import { canonicalFollow } from "./follows.js";

const encoder = new TextEncoder();
const bytes = (value) => encoder.encode(value).length;
const keys = (value, expected) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === expected;
const instant = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))
    return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : null;
};
const text = (value, maximum) =>
  typeof value === "string" &&
  value.length > 0 &&
  value === value.trim() &&
  !/[\u0000-\u001f\u007f\ud800-\udfff]/u.test(value) &&
  bytes(value) <= maximum;
const invalid = (reason) => ({ status: "invalid", reason });

export async function followSnapshotDigest(input) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...hash].map((value) => value.toString(16).padStart(2, "0")).join("");
}

const list = (values, allowed) =>
  Array.isArray(values) &&
  values.length <= 64 &&
  new Set(values).size === values.length &&
  values.every((value) => typeof value === "string" && allowed.has(value));
const posting = (value) => {
  // Same posting boundary as the independently owned mail renderer; no first-party URL policy.
  if (
    typeof value !== "string" ||
    value.length > 2000 ||
    /[\s\x00-\x1f\x7f<>"\\]/.test(value) ||
    !/^https?:\/\/[^/]/i.test(value)
  )
    return false;
  try {
    const url = new URL(value);
    return !!url.hostname && !/^https?:\/\/[^/?#]*@/i.test(value) && url.href.length <= 2000;
  } catch {
    return false;
  }
};

// Limits and upperBound are trusted explicit inputs, never defaults inferred from the clock
// or this untrusted JSON. The producer attests a complete eligible window, never a top-N cut.
export function matchFollowSnapshot(input, follows, { catalog, limits, upperBound } = {}) {
  if (
    !limits ||
    ![
      "maxBytes",
      "maxRoles",
      "maxFollows",
      "maxMatches",
      "maxResultBytes",
      "maxTextBytes",
      "maxWindowMs",
    ].every((key) => Number.isSafeInteger(limits[key]) && limits[key] > 0) ||
    !catalog ||
    !["companies", "fields", "states"].every((key) => catalog[key] instanceof Set)
  )
    return invalid("configuration");
  const upper = instant(upperBound);
  if (upper === null || !(input instanceof Uint8Array) || input.byteLength > limits.maxBytes)
    return invalid("snapshot_bound");
  let snapshot;
  try {
    snapshot = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input));
  } catch {
    return invalid("snapshot_json");
  }
  if (
    !keys(snapshot, "complete,covers_after,generated_at,roles,version") ||
    snapshot.version !== 1 ||
    snapshot.complete !== true ||
    snapshot.generated_at !== upperBound
  )
    return invalid("snapshot_contract");
  const lower = instant(snapshot.covers_after);
  if (
    lower === null ||
    lower >= upper ||
    upper - lower > limits.maxWindowMs ||
    !Array.isArray(snapshot.roles) ||
    snapshot.roles.length > limits.maxRoles
  )
    return invalid("snapshot_window");
  const seen = new Set(),
    firstSeen = new Map();
  for (const role of snapshot.roles) {
    if (
      !keys(
        role,
        "apply_url,company_key,company_name,field_tags,first_seen,id,location,states,status,title",
      ) ||
      typeof role.id !== "string" ||
      !/^[a-f0-9]{16}$/.test(role.id) ||
      seen.has(role.id) ||
      role.status !== "open" ||
      !text(role.company_key, 200) ||
      !catalog.companies.has(role.company_key) ||
      role.company_name?.length > 200 ||
      role.title?.length > 300 ||
      role.location?.length > 300 ||
      ![role.company_name, role.title, role.location].every((value) =>
        text(value, limits.maxTextBytes),
      ) ||
      !text(role.apply_url, limits.maxTextBytes) ||
      !posting(role.apply_url) ||
      !list(role.field_tags, catalog.fields) ||
      !list(role.states, catalog.states)
    )
      return invalid("role_contract");
    const first = instant(role.first_seen);
    if (first === null || first <= lower || first > upper) return invalid("role_time");
    seen.add(role.id);
    firstSeen.set(role.id, first);
  }
  if (!Array.isArray(follows) || follows.length > limits.maxFollows) return invalid("follow_bound");
  const scopes = new Set(),
    refs = [],
    advances = [],
    matched = new Set();
  let referenceBytes = 0;
  for (const follow of follows) {
    if (
      !keys(follow, "confirmed_at,scope_key,watermark") ||
      typeof follow.scope_key !== "string" ||
      bytes(follow.scope_key) > limits.maxBytes ||
      scopes.has(follow.scope_key)
    )
      return invalid("follow_contract");
    let scope;
    try {
      scope = JSON.parse(follow.scope_key);
      if (canonicalFollow(scope, catalog) !== follow.scope_key) return invalid("follow_scope");
    } catch {
      return invalid("follow_scope");
    }
    scopes.add(follow.scope_key);
    if (follow.confirmed_at === null && follow.watermark === null) continue;
    const confirmed = instant(follow.confirmed_at),
      prior = follow.watermark === null ? confirmed : instant(follow.watermark);
    const after = Math.max(confirmed, prior);
    if (confirmed === null || prior === null || after > upper || after < lower)
      return invalid("follow_window");
    const ids = snapshot.roles
      .filter(
        (role) =>
          firstSeen.get(role.id) > after &&
          (scope.kind === "company"
            ? role.company_key === scope.company
            : (!scope.fields.length ||
                scope.fields.some((field) => role.field_tags.includes(field))) &&
              (!scope.states.length || scope.states.some((state) => role.states.includes(state)))),
      )
      .map((role) => role.id);
    if (ids.length) refs.push({ scopeKey: follow.scope_key, roles: ids });
    ids.forEach((id) => matched.add(id));
    if (matched.size > limits.maxMatches) return invalid("match_bound");
    advances.push({
      scopeKey: follow.scope_key,
      confirmedAt: follow.confirmed_at,
      from: follow.watermark,
      to: upperBound,
    });
    referenceBytes +=
      bytes(JSON.stringify(advances.at(-1))) +
      (ids.length ? bytes(JSON.stringify(refs.at(-1))) : 0);
    if (referenceBytes > limits.maxResultBytes) return invalid("result_bound");
  }
  const result = {
    status: "matched",
    roles: snapshot.roles.filter((role) => matched.has(role.id)),
    refs,
    advances,
  };
  return bytes(JSON.stringify(result)) > limits.maxResultBytes ? invalid("result_bound") : result;
}
