import { siteUrl } from "../billing.js";
import { HttpError } from "../http.js";
import { CONTROL, LISTING_ID, bad } from "./shared.js";

const SHARD = /^[a-z0-9_]$/;
const FIELD = /^[a-z0-9_-]{1,40}$/;

// ---------------------------------------------------------------- the role index

export const shardOf = (key) => {
  const c = String(key || "").charAt(0);
  return /^[a-z0-9]$/.test(c) ? c : "_";
};

// One role from the index, or null when anything about it is not the shape we expect. The index is our
// own file, but it comes over the network, so nothing in it is trusted to be well formed.
function cleanRole(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const str = (v, max, required = true) => {
    if (v == null && !required) return "";
    if (typeof v !== "string") return null;
    const s = v.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
    return (!s && required) || s.length > max ? null : s;
  };
  const id = typeof r.id === "string" && LISTING_ID.test(r.id) ? r.id : null;
  const k = str(r.k, 120), co = str(r.co, 120), t = str(r.t, 200), loc = str(r.loc, 200, false), u = str(r.u, 2000);
  if (!id || k == null || co == null || t == null || loc == null || u == null) return null;
  try {
    const url = new URL(u);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) return null;
  } catch {
    return null;
  }
  const f = Array.isArray(r.f) ? r.f.filter((x) => typeof x === "string" && FIELD.test(x)) : [];
  return { id, k, co, t, loc, u, f: [...new Set(f)].slice(0, 20), unpaid: r.unpaid === true };
}

// The open roles in one shard of the site's role index (backend role_index.py), by id. A shard file
// the site does not have (404) is an empty shard: no employer there has open roles today.
export async function readShard(env, shard, fetchImpl) {
  if (typeof shard !== "string" || !SHARD.test(shard)) throw bad("shard", "shard must be one of a-z, 0-9 or _");
  let res, data = null;
  try {
    // The site's file changes once per build; a few minutes of edge cache spares GitHub Pages.
    res = await fetchImpl(`${siteUrl(env)}/data/roles/${shard}.json`, { cf: { cacheTtl: 300, cacheEverything: true } });
    if (res.status === 404) return new Map();
    if (res.ok) data = await res.json();
  } catch {}
  if (!data || typeof data !== "object" || !Array.isArray(data.roles)) {
    throw new HttpError(502, "roles_unavailable", "The list of open roles can't be read right now. Please try again in a few minutes.");
  }
  const roles = new Map();
  for (const r of data.roles.slice(0, 20_000)) {
    const c = cleanRole(r);
    if (c && !roles.has(c.id)) roles.set(c.id, c);
  }
  return roles;
}
