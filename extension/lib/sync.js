// Saving the Deep Dive to the student's account (worker/API.md → Profile), so it's there on their other
// devices. Run by the background service worker; pages only use the small helpers at the bottom.
//
// What goes up is the synced subset: the profile (minus the six demographic answers), whether the Deep Dive
// is finished and when, and the dashboard profile. Never: files, accounts (saved logins), API keys, the
// master password, the sign-up email, the answers log or the job queue. Those stay on this device.
//
// How it moves:
// - storage.onChanged on the store notices an edit to the synced subset (isLocalEdit), notes the time in
//   PENDING_KEY at once and flushes about 5 seconds later. The note is in storage, not memory, so an edit
//   made just before Chrome stops the service worker is still sent when it next starts (flushPending).
// - flush stamps settings.profile_updated_at with the edit time and PUTs the subset. A 409 means the
//   account has a newer copy (another device): that copy is applied here instead.
// - pull (syncNow) runs after every sign-in, at browser startup and when the extension is installed or
//   updated. The account's copy replaces the local one when it is newer, or when this device has never
//   finished a Deep Dive but the account has one. The local demographic answers are always kept.
// - settings.profile_synced_hash is the hash of the subset as the account holds it (as far as we know).
//   Local and account agree when the local subset hashes to it.
// Signed out, cloud_sync off, or a Worker without profile saving (404, 503 sync_off): nothing happens.
import { loadStore, updateStore, emptyStore, deepMerge, EMPTY_FACTS, DEMOGRAPHIC_KEYS } from "./store.js";
import { ensureToken, workerFetch } from "./auth.js";

// Keys in profile.facts that never leave the device (the Worker also strips them, as a second line).
// was: defined here; lib/store.js needs them too, for confirmedFacts' decline default.
export { DEMOGRAPHIC_KEYS };
// profile.extra holds answers the agent learned on application forms ({question text: answer}). An
// employer's own voluntary self-identification question lands there too, so any entry whose question
// reads like one of the six stays on the device with them. Erring wide is fine: a dropped entry is only
// asked again on the next device.
export const DEMOGRAPHIC_QUESTION = /\b(gender|sex|race|racial|ethnic|ethnicity|hispanic|latin[oax]|veteran|military status|protected veteran|disabilit|handicap|lgbt|sexual orientation|transgender|self-identif)/i;
// Settings only the background writes. A page saving its own copy of the store keeps the stored values
// of these, or it would undo a sync that happened while it was open.
export const BACKGROUND_SETTINGS = ["cloud_sync", "profile_updated_at", "profile_synced_hash"];
export const PENDING_KEY = "internscout.sync";       // { dirty_at: ISO } an edit not yet flushed
export const RESTORED_KEY = "internscout.restored";  // { updated, at, shown } the last restore, for the UI
export const DEBOUNCE_MS = 5000;

// ---------- pure ----------
export function withoutDemographics(facts) {
  const out = { ...(facts || {}) };
  for (const k of DEMOGRAPHIC_KEYS) delete out[k];
  return out;
}

export function withoutDemographicAnswers(extra) {
  return Object.fromEntries(Object.entries(extra || {}).filter(([q]) => !DEMOGRAPHIC_QUESTION.test(q)));
}

export function syncedSubset(s) {
  const p = (s && s.profile) || {};
  const st = (s && s.settings) || {};
  return {
    // was: profile: { ...p, facts: withoutDemographics(p.facts) },
    profile: { ...p, facts: withoutDemographics(p.facts), extra: withoutDemographicAnswers(p.extra),
      ...(p.sources ? { sources: { ...p.sources, facts: withoutDemographics(p.sources.facts) } } : {}) },
    settings: { onboarded: !!st.onboarded, deep_dive_at: st.deep_dive_at ?? null },
    dashboard_profile: (s && s.dashboard_profile) ?? null,
  };
}

// JSON with object keys sorted, so the same data always gives the same text (and hash).
export function stableStringify(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : stableStringify(x))).join(",")}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}

// cyrb53: a fast 53-bit string hash. Only to notice changes; nothing secret depends on it.
export function hashOf(v) {
  const str = stableStringify(v);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

// PUT /profile's body.profile. The profile's own keys sit at the top (so the Worker finds profile.facts
// to strip), with the two settings and the dashboard profile beside them.
export function toServer(sub) {
  return { ...sub.profile, settings: sub.settings, dashboard_profile: sub.dashboard_profile };
}

// The account's copy put into this store: the synced subset is replaced, the local demographic answers
// stay, and a finished Deep Dive on the account marks this device finished too (never the reverse).
// Changes s and returns it.
export function applyServer(s, serverProfile, updated) {
  const { settings = {}, dashboard_profile = null, ...profile } = serverProfile || {};
  const mine = (s.profile && s.profile.facts) || {};
  const mySources = (s.profile && s.profile.sources && s.profile.sources.facts) || {};
  const myExtra = (s.profile && s.profile.extra) || {};
  s.profile = deepMerge(emptyStore().profile, profile);
  // Whatever the account's copy says about these (it should say nothing), this device's answers stand,
  // with where they came from: an interview's suggestion must stay a suggestion (store.js confirmedFacts).
  // was: the answers only, so a suggested race or veteran status lost its record and counted as confirmed.
  s.profile.sources.facts ||= {};
  for (const k of DEMOGRAPHIC_KEYS) {
    s.profile.facts[k] = k in mine ? mine[k] : EMPTY_FACTS[k];
    if (mySources[k]) s.profile.sources.facts[k] = mySources[k];
    else delete s.profile.sources.facts[k];
  }
  // The same for learned self-identification answers: the account's copy never has them, so keep ours.
  const extra = withoutDemographicAnswers(s.profile.extra);
  for (const [q, a] of Object.entries(myExtra)) if (DEMOGRAPHIC_QUESTION.test(q)) extra[q] = a;
  s.profile.extra = extra;
  s.dashboard_profile = dashboard_profile || null;
  if (settings.onboarded) s.settings.onboarded = true;
  if (settings.deep_dive_at != null) s.settings.deep_dive_at = settings.deep_dive_at;
  if (updated) s.settings.profile_updated_at = updated;
  return s;
}

// The subset as the account holds it (for comparing with the local one).
export function serverSubset(serverProfile) {
  return syncedSubset(applyServer(emptyStore(), serverProfile));
}

const EMPTY_HASH = hashOf(syncedSubset(emptyStore()));
const time = (iso) => Date.parse(iso) || 0;

// A device that has finished a Deep Dive at some point. deep_dive_at is only set by finishing it
// (onboarding/quickstart.js) or by a restore of a finished one, and nothing clears it.
const finishedHere = (s) => !!s.settings.onboarded || s.settings.deep_dive_at != null;

// What a pull does with GET /profile's reply { profile, updated }:
// "restore" (take the account's copy), "push" (send ours), "same" (already equal) or "none".
export function decide(s, server) {
  const localHash = hashOf(syncedSubset(s));
  const sp = server && server.profile;
  if (!sp) return localHash === EMPTY_HASH ? "none" : "push";
  if (hashOf(serverSubset(sp)) === localHash) return "same";
  const serverDone = !!(sp.settings && sp.settings.onboarded);
  // An unfinished Deep Dive here gives way to a finished one on the account even when it was edited later
  // (a fresh install). Two unfinished ones: the newer wins, so a device part way through keeps its work.
  // A device that has finished before never gives way to an older copy: its newer edits are pushed.
  // was: (!s.settings.onboarded && serverDone), which a resume replacement (onboarded=false at the time)
  // turned into a restore of the old profile, newer local work and all.
  if (localHash === EMPTY_HASH || time(server.updated) > time(s.settings.profile_updated_at)
      || (!finishedHere(s) && serverDone)) return "restore";
  return "push";
}

// storage.onChanged on the store: true when the synced subset changed and the change isn't a sync
// writing the account's copy (that write sets profile_synced_hash to match). A new store (no old value)
// is not an edit: pushing an empty profile over the account's copy is exactly what must not happen.
export function isLocalEdit(oldValue, newValue) {
  if (!oldValue || !newValue) return false;
  const h = hashOf(syncedSubset(newValue));
  if (h === hashOf(syncedSubset(oldValue))) return false;
  return h !== ((newValue.settings || {}).profile_synced_hash ?? null);
}

// "Restored your Deep Dive from your account (saved Sep 24, 2026)."
export function restoredMessage(r) {
  if (!r) return "";
  const d = new Date(r.updated);
  const when = isNaN(d) ? "" : ` (saved ${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })})`;
  return `Restored your Deep Dive from your account${when}.`;
}

// ---------- chrome-backed (background) ----------
const local = async (k) => (await chrome.storage.local.get(k))[k] || null;
const nowIso = () => new Date().toISOString();
// 2026-10-23: consent changes invalidate even already queued replies (EXT-2).
// was: consent was checked only before network I/O. Revert: remove epoch checks and consent queue.
let syncEpoch = 0;
const allowed = (s, epoch) => epoch === syncEpoch && s.settings.cloud_sync !== false;

// { status, ok, data } of a Worker reply; status 0 when there was none (signed out or offline).
async function answer(res) {
  if (!res) return { status: 0, ok: false, data: {} };
  return { status: res.status, ok: res.ok, data: await res.json().catch(() => ({})) };
}
const failState = (status) => (status === 401 || status === 0 ? "signed_out_or_offline" : status === 413 ? "too_big" : "unavailable");

// Moves a noted edit time into settings.profile_updated_at.
async function stampPending() {
  // 2026-10-23: consume the edit marker under the same store lock used by noteEdit (EXT-3).
  // was: read outside the lock and remove afterward, which could delete a newer edit's marker.
  // Revert: move marker I/O outside this callback and restore noteEdit's standalone marker write.
  let pend;
  await updateStore(async (s) => {
    pend = await local(PENDING_KEY);
    if (!pend) return;
    if (time(pend.dirty_at) > time(s.settings.profile_updated_at)) s.settings.profile_updated_at = pend.dirty_at;
  }, {
    afterSave: async () => { if (pend) await chrome.storage.local.remove(PENDING_KEY); },
  });
}

async function restore(serverProfile, updated, expectedHash, epoch, expectedUpdated) {
  let changed = false, localChanged = false, stopped = false;
  await updateStore((s) => {
    if (!allowed(s, epoch)) { stopped = true; return; }
    const before = hashOf(syncedSubset(s));
    // 2026-10-23: a network reply must not replace edits made while it was pending (EXT-3).
    // was: restore unconditionally used the profile read before GET/PUT. Revert: remove this check.
    // 2026-10-23: a just-stamped manual edit may have the same hash as the GET snapshot.
    // was: hash alone; a delayed timestamp could let an older remote copy overwrite that edit.
    // Revert: remove the expectedUpdated comparison and its call arguments.
    if (before !== expectedHash || (s.settings.profile_updated_at ?? null) !== (expectedUpdated ?? null)) {
      localChanged = true; return;
    }
    applyServer(s, serverProfile, updated);
    // The account's own hash, not the merged one: when this device kept something the account lacks
    // (a finished Deep Dive), the difference shows up as an edit and is pushed.
    s.settings.profile_synced_hash = hashOf(serverSubset(serverProfile));
    changed = hashOf(syncedSubset(s)) !== before;
  });
  if (stopped) return { state: "off" };
  if (localChanged) return { state: "local_changed" };
  if (changed) await chrome.storage.local.set({ [RESTORED_KEY]: { updated, at: nowIso(), shown: false } });
  return { state: changed ? "restored" : "same", updated };
}

async function push(token, epoch) {
  const s = await loadStore();
  if (!allowed(s, epoch)) return { state: "off" };
  const sub = syncedSubset(s), h = hashOf(sub);
  if (h === EMPTY_HASH) return { state: "none" };
  const updated = s.settings.profile_updated_at || nowIso();
  const r = await answer(await workerFetch("/profile", {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: toServer(sub), updated }),
  }, token));
  if (epoch !== syncEpoch) return { state: "off" };
  if (r.ok) {
    await updateStore((x) => {
      if (!allowed(x, epoch)) return;
      x.settings.profile_synced_hash = h;
      // Only when nothing newer was stamped meanwhile.
      if (time(x.settings.profile_updated_at) <= time(updated)) x.settings.profile_updated_at = r.data.updated || updated;
    });
    return { state: "pushed" };
  }
  if (r.status === 409 && r.data && r.data.profile) return restore(r.data.profile, r.data.updated, h, epoch, s.settings.profile_updated_at);
  return { state: failState(r.status) };
}

async function run({ pushOnly = false } = {}, epoch = syncEpoch) {
  if (epoch !== syncEpoch) return { state: "off" };
  await stampPending();
  const s = await loadStore();
  if (!allowed(s, epoch)) return { state: "off" };
  const token = await ensureToken();
  if (epoch !== syncEpoch) return { state: "off" };
  if (!token) return { state: "signed_out" };
  // A push without a pull first only when this device has matched the account before; otherwise the
  // account may hold a newer Deep Dive that a blind push would bury.
  if (pushOnly && s.settings.profile_synced_hash != null) {
    return hashOf(syncedSubset(s)) === s.settings.profile_synced_hash ? { state: "same" } : push(token, epoch);
  }
  const r = await answer(await workerFetch("/profile", {}, token));
  if (epoch !== syncEpoch) return { state: "off" };
  if (!r.ok) return { state: failState(r.status) };
  switch (decide(s, r.data)) {
    case "restore": return restore(r.data.profile, r.data.updated, hashOf(syncedSubset(s)), epoch, s.settings.profile_updated_at);
    case "push": return push(token, epoch);
    case "same":
      await updateStore((x) => {
        if (!allowed(x, epoch)) return;
        // 2026-10-23: only acknowledge the revision actually compared with the server (EXT-3).
        // was: a newer manual edit could be falsely marked synced. Revert: remove this check.
        if (hashOf(syncedSubset(x)) !== hashOf(syncedSubset(s))) return;
        x.settings.profile_synced_hash = hashOf(syncedSubset(x));
        if (!x.settings.profile_updated_at) x.settings.profile_updated_at = r.data.updated || null;
      });
      return { state: "same" };
    default: return { state: "none" };
  }
}

// One sync at a time: a pull and a flush must not interleave their reads and writes.
let chain = Promise.resolve();
function queueOperation(work) {
  const p = chain.then(work);
  chain = p.catch(() => {});
  return p;
}
function queued(opts) {
  const epoch = syncEpoch;
  return queueOperation(() => run(opts, epoch));
}

// Pull (and push when ours is newer). After sign-in, at browser startup, on install or update.
export const syncNow = () => queued({ pushOnly: false });

// Push the edits noted by noteEdit.
export const flush = () => queued({ pushOnly: true });

let timer = null;
// A local edit to the synced subset: note the time now (survives the worker stopping), send it shortly.
export async function noteEdit() {
  const dirty = nowIso();
  // 2026-10-23: publish the local revision and its pending marker as one locked edit.
  // was: only the marker was saved; stampPending could erase it while a sync was starting.
  // Revert: restore the standalone marker write together with stampPending's old implementation.
  await updateStore(async (s) => {
    const previous = await local(PENDING_KEY);
    const dirty_at = time(previous?.dirty_at) > time(dirty) ? previous.dirty_at : dirty;
    if (time(dirty_at) > time(s.settings.profile_updated_at)) s.settings.profile_updated_at = dirty_at;
    await chrome.storage.local.set({ [PENDING_KEY]: { dirty_at } });
  });
  clearTimeout(timer);
  timer = setTimeout(() => { flush().catch(() => {}); }, DEBOUNCE_MS);
}

// Service worker start: an edit noted before Chrome stopped the worker is sent now.
export async function flushPending() {
  if (await local(PENDING_KEY)) return flush();
  return { state: "none" };
}

// The Deep Dive's switch. Off: the account's copy is deleted first (DELETE /profile), then syncing stops.
// On: syncing starts again and this device's copy is sent (or the account's newer one taken).
export async function setCloudSync(on) {
  const epoch = ++syncEpoch;
  clearTimeout(timer);
  // 2026-10-23: DELETE must finish after every older PUT, including a PUT already in flight.
  // was: DELETE ran beside sync, allowing PUT to recreate the deleted copy. Revert: remove queue.
  return queueOperation(async () => {
  if (!on) {
    const r = await answer(await workerFetch("/profile", { method: "DELETE" }));
    // 2026-10-23: 503 cannot prove deletion, even sync_off may leave an existing encrypted row.
    // was: every 503 counted as deleted. Revert: restore the old 503 exception.
    if (!r.ok && r.status !== 404) {
      return { ok: false, error: r.status === 401 || r.status === 0 ? "auth_or_network" : r.data.error || String(r.status), message: r.data.message || "" };
    }
    await updateStore((s) => { s.settings.cloud_sync = false; s.settings.profile_synced_hash = null; });
    return { ok: true };
  }
  await updateStore((s) => { s.settings.cloud_sync = true; s.settings.profile_synced_hash = null; });
  return { ok: true, ...(await run({}, epoch).catch(() => ({ state: "unavailable" }))) };
  });
}

// Signed out (or the server data deleted): what the account holds is no longer known here, so the next
// sign-in (maybe another account) pulls before it pushes.
export async function forgetSynced({ stop = false, finish } = {}) {
  ++syncEpoch;
  clearTimeout(timer);
  await queueOperation(async () => {
    await updateStore((s) => {
      s.settings.profile_synced_hash = null;
      if (stop) s.settings.cloud_sync = false;
    });
    // 2026-10-23: fresh sync requests must also wait until sign-out removes the token.
    // was: only older replies were invalidated. Revert: sign out after forgetSynced returns.
    if (finish) await finish();
  });
}

// 2026-10-23: account deletion shares the upload barrier, so an older PUT cannot recreate its data.
// was: DELETE /me ran beside profile sync. Revert: call the deletion directly in background/index.js.
export async function deleteSyncedAccount(removeAccount) {
  ++syncEpoch;
  clearTimeout(timer);
  return queueOperation(async () => {
    const result = await removeAccount();
    if (result.ok) await updateStore((s) => { s.settings.cloud_sync = false; s.settings.profile_synced_hash = null; });
    return result;
  });
}

// ---------- for pages ----------
// The last restore, once: returns it and marks it shown, or null.
export async function takeRestored() {
  const r = await local(RESTORED_KEY);
  if (!r || r.shown) return null;
  await chrome.storage.local.set({ [RESTORED_KEY]: { ...r, shown: true } });
  return r;
}
export const restoredAt = async () => ((await local(RESTORED_KEY)) || {}).at || null;
