// Saving the Deep Dive to the account: what is sent (never demographics, logins, keys or files), how
// changes are noticed, which copy wins, and that a restore on a new computer skips the Deep Dive.
import test from "node:test";
import assert from "node:assert/strict";

const store = (data) => ({
  async get(k) { return k == null ? { ...data } : Object.fromEntries([].concat(k).map((x) => [x, data[x]]).filter(([, v]) => v !== undefined)); },
  async set(o) { for (const [k, v] of Object.entries(o)) data[k] = JSON.parse(JSON.stringify(v)); },
  async remove(k) { for (const x of [].concat(k)) delete data[x]; },
});
const LOCAL = {}, SESSION = {};
globalThis.chrome = { storage: { local: store(LOCAL), session: store(SESSION) } };
const calls = [];
let routes = {};   // "METHOD /path" → (body) => [status, reply]; missing → network error
globalThis.fetch = async (url, init = {}) => {
  const key = `${init.method || "GET"} ${new URL(url).pathname}`;
  const body = init.body ? JSON.parse(init.body) : null;
  calls.push({ key, body, auth: init.headers && init.headers.authorization });
  const h = routes[key];
  if (!h) throw new TypeError("fetch failed");
  const [status, reply] = await h(body);
  return { ok: status >= 200 && status < 300, status, json: async () => reply };
};

const S = await import("../lib/sync.js");
const { emptyStore, loadStore } = await import("../lib/store.js");

const DEMO = { gender: "Woman", race: "Asian", hispanic: "No", veteran: "I am not a protected veteran", disability: "No", lgbtq: "Yes" };
function filled({ onboarded = true, updated = null, synced = null } = {}) {
  const s = emptyStore();
  Object.assign(s.profile.facts, { first_name: "Sam", last_name: "Lee", email: "sam@school.edu", ...DEMO });
  s.profile.education.push({ school: "UMass Amherst", degree: "BS", major: "Computer Science" });
  s.profile.stories.push({ theme: "challenge", situation: "a hard bug" });
  s.profile.extra["Why us?"] = "Because.";
  s.files.resume = { name: "resume.pdf", type: "application/pdf", b64: "SECRETFILEBYTES", size: 10 };
  s.accounts.push({ domain: "acme.myworkdayjobs.com", email: "sam@school.edu", password: "placeholder-pw" });
  Object.assign(s.ai, { apiKey: "placeholder-anthropic", geminiKey: "placeholder-gemini" });
  Object.assign(s.settings, { signup_email: "apply@school.edu", master_password: "placeholder-master", onboarded, deep_dive_at: onboarded ? 1758800000000 : null,
    profile_updated_at: updated, profile_synced_hash: synced });
  s.answers.push({ question: "q", answer: "ANSWERSECRET" });
  s.dashboard_profile = { majors: ["Computer Science"], minors: [], class_year: "Junior", grad_term: "Spring 2028", stages: [], terms: [], states: ["MA"], work_auth: "" };
  return s;
}
const SESSION_REC = { token: "iss_live", account: "0123456789abcdef", email: "sam@school.edu", provider: "google", tier: "edu",
  expires: new Date(Date.now() + 864e5).toISOString() };
function reset(s, { signedIn = true } = {}) {
  for (const o of [LOCAL, SESSION]) for (const k of Object.keys(o)) delete o[k];
  calls.length = 0; routes = {};
  if (s) LOCAL.store = JSON.parse(JSON.stringify(s));
  if (signedIn) LOCAL["internscout.session"] = { ...SESSION_REC };
}
const T1 = "2026-09-20T10:00:00.000Z", T2 = "2026-09-24T10:00:00.000Z", T3 = "2026-09-28T10:00:00.000Z";
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test("opt-out invalidates a pending pull and every older queued flush", async () => {
  reset(filled({ updated: T1 }));
  const started = deferred(), response = deferred();
  routes = {
    "GET /profile": async () => { started.resolve(); return response.promise; },
    "DELETE /profile": () => [200, { ok: true }],
    "PUT /profile": () => { assert.fail("an older sync uploaded after opt-out"); },
  };
  const pulling = S.syncNow();
  await started.promise;
  const queuedFlush = S.flush();
  const disabling = S.setCloudSync(false);
  response.resolve([200, { profile: null }]);
  assert.equal((await pulling).state, "off");
  assert.equal((await queuedFlush).state, "off");
  assert.deepEqual(await disabling, { ok: true });
  assert.deepEqual(calls.map(c => c.key), ["GET /profile", "DELETE /profile"]);
  assert.equal((await loadStore()).settings.cloud_sync, false);
});

test("opt-out waits for an already dispatched upload then deletes its remote result", async () => {
  reset(filled({ updated: T1, synced: "different" }));
  const started = deferred(), response = deferred();
  let remote = null;
  routes = {
    "PUT /profile": async body => { started.resolve(); await response.promise; remote = body.profile; return [200, { updated: T1 }]; },
    "DELETE /profile": () => { remote = null; return [200, { ok: true }]; },
  };
  const uploading = S.flush();
  await started.promise;
  const disabling = S.setCloudSync(false);
  await Promise.resolve();
  assert.deepEqual(calls.map(c => c.key), ["PUT /profile"]);
  response.resolve();
  await uploading;
  assert.deepEqual(await disabling, { ok: true });
  assert.equal(remote, null);
  assert.deepEqual(calls.map(c => c.key), ["PUT /profile", "DELETE /profile"]);
  assert.equal((await loadStore()).settings.profile_synced_hash, null);
});

test("opt-out suppresses late restores and re-enabling runs a fresh consent generation", async () => {
  reset(emptyStore());
  const started = deferred(), response = deferred();
  let gets = 0;
  routes = {
    "GET /profile": async () => {
      if (++gets === 1) { started.resolve(); return response.promise; }
      return [200, { profile: null }];
    },
    "DELETE /profile": () => [200, { ok: true }],
  };
  const pulling = S.syncNow();
  await started.promise;
  const disabling = S.setCloudSync(false);
  response.resolve([200, { profile: S.toServer(S.syncedSubset(filled())), updated: T2 }]);
  await pulling; await disabling;
  assert.equal((await loadStore()).settings.onboarded, false);
  assert.equal(LOCAL[S.RESTORED_KEY], undefined);
  assert.equal((await S.setCloudSync(true)).ok, true);
  assert.deepEqual(calls.map(c => c.key), ["GET /profile", "DELETE /profile", "GET /profile"]);
  assert.equal((await loadStore()).settings.cloud_sync, true);
});

test("an unavailable deletion never reports that the saved profile is gone", async () => {
  for (const error of ["sync_off", "unavailable"]) {
    reset(filled());
    routes = { "DELETE /profile": () => [503, { error }] };
    assert.equal((await S.setCloudSync(false)).ok, false);
    assert.equal((await loadStore()).settings.cloud_sync, true);
  }
});

test("account deletion drains uploads before deleting and stops later queued sync", async () => {
  reset(filled({ updated: T1, synced: "different" }));
  const started = deferred(), response = deferred();
  let remote = null;
  routes = { "PUT /profile": async body => { started.resolve(); await response.promise; remote = body.profile; return [200, {}]; } };
  const uploading = S.flush();
  await started.promise;
  const deleting = S.deleteSyncedAccount(async () => { remote = null; return { ok: true }; });
  const queuedFlush = S.flush();
  response.resolve();
  await uploading;
  assert.equal((await deleting).ok, true);
  assert.equal((await queuedFlush).state, "off");
  assert.equal(remote, null);
  assert.equal((await loadStore()).settings.cloud_sync, false);
});

test("new sync requests during sign-out wait until the old token has been removed", async () => {
  reset(filled());
  const started = deferred(), finish = deferred();
  const signingOut = S.forgetSynced({ finish: async () => {
    started.resolve(); await finish.promise;
    delete LOCAL["internscout.session"];
  } });
  await started.promise;
  const newRequest = S.syncNow();
  finish.resolve();
  await signingOut;
  assert.equal((await newRequest).state, "signed_out");
  assert.deepEqual(calls, []);
});

test("the synced subset leaves out demographics, logins, keys, passwords, files, answers and the sign-up email", () => {
  const sub = S.syncedSubset(filled());
  assert.deepEqual(Object.keys(sub).sort(), ["dashboard_profile", "profile", "settings"]);
  assert.deepEqual(sub.settings, { onboarded: true, deep_dive_at: 1758800000000 });
  for (const k of S.DEMOGRAPHIC_KEYS) assert.ok(!(k in sub.profile.facts), k);
  assert.equal(sub.profile.facts.first_name, "Sam");
  assert.equal(sub.profile.extra["Why us?"], "Because.");
  assert.equal(sub.dashboard_profile.class_year, "Junior");
  const body = JSON.stringify({ profile: S.toServer(sub) });
  for (const secret of ["SECRETFILEBYTES", "placeholder-pw", "placeholder-anthropic", "placeholder-gemini", "placeholder-master", "apply@school.edu", "ANSWERSECRET",
    "Woman", "Asian", "protected veteran", "lgbtq", "\"gender\"", "\"race\""]) assert.ok(!body.includes(secret), secret);
  // The Worker strips profile.facts again, so facts must sit right under body.profile.
  const out = S.toServer(sub);
  assert.equal(out.facts.first_name, "Sam");
  assert.deepEqual(out.settings, sub.settings);
});

test("demographic provenance stays local while resume/contact provenance can sync", () => {
  const local = filled();
  local.profile.sources = { facts: { first_name: { kind: "resume", value: "Sam" },
    ...Object.fromEntries(S.DEMOGRAPHIC_KEYS.map(k => [k, { kind: "manual", value: "PRIVATE-" + k }])) } };
  const subset = S.syncedSubset(local);
  const body = JSON.stringify(S.toServer(subset));
  assert.ok(!body.includes("PRIVATE-"));
  assert.equal(subset.profile.sources.facts.first_name.value, "Sam");
  assert.equal(local.profile.sources.facts.gender.value, "PRIVATE-gender");
  const before = S.hashOf(subset);
  local.profile.sources.facts.gender.value = "CHANGED-PRIVATE";
  assert.equal(S.hashOf(S.syncedSubset(local)), before);
});

test("the hash ignores key order, demographics and non-synced data, and sees real edits", () => {
  const a = filled(), h = S.hashOf(S.syncedSubset(a));
  const reordered = { dashboard_profile: a.dashboard_profile, settings: { ...a.settings }, profile: Object.fromEntries(Object.entries(a.profile).reverse()) };
  assert.equal(S.hashOf(S.syncedSubset(reordered)), h);
  assert.equal(S.hashOf({ b: 1, a: [1, { d: 2, c: 3 }] }), S.hashOf({ a: [1, { c: 3, d: 2 }], b: 1 }));
  const b = filled(); b.profile.facts.gender = "Man"; b.accounts = []; b.files.resume = null; b.settings.ai_mode = "best";
  assert.equal(S.hashOf(S.syncedSubset(b)), h);
  const c = filled(); c.profile.goals.career = "Robotics";
  assert.notEqual(S.hashOf(S.syncedSubset(c)), h);
  const d = filled(); d.settings.onboarded = false;
  assert.notEqual(S.hashOf(S.syncedSubset(d)), h);
});

test("the account's copy replaces the profile but keeps this device's demographic answers", () => {
  const server = S.toServer(S.syncedSubset(filled()));
  server.goals = { ...server.goals, career: "From the other laptop" };
  server.facts = { ...server.facts, gender: "SHOULD NOT LAND" };   // a copy should never carry these; if it does, ours stand
  const local = emptyStore();
  local.profile.facts.gender = "Non-binary";
  S.applyServer(local, server, T2);
  assert.equal(local.profile.goals.career, "From the other laptop");
  assert.equal(local.profile.facts.first_name, "Sam");
  assert.equal(local.profile.facts.gender, "Non-binary");
  assert.equal(local.profile.facts.race, "Decline to self-identify");   // the local default, not the account's
  assert.equal(local.settings.onboarded, true);
  assert.equal(local.settings.profile_updated_at, T2);
  assert.equal(local.dashboard_profile.class_year, "Junior");
  // A finished Deep Dive here is never unfinished by the account's copy.
  const done = filled();
  S.applyServer(done, { ...server, settings: { onboarded: false, deep_dive_at: null } }, T2);
  assert.equal(done.settings.onboarded, true);
});

test("which copy wins: newer wins; a finished account copy beats an unfinished device; empty never pushes", () => {
  const server = (s, updated) => ({ profile: S.toServer(S.syncedSubset(s)), updated });
  const other = filled(); other.profile.goals.career = "Other";
  assert.equal(S.decide(filled({ updated: T1 }), server(other, T2)), "restore");
  assert.equal(S.decide(filled({ updated: T2 }), server(other, T1)), "push");
  assert.equal(S.decide(filled({ updated: T1 }), server(filled(), T2)), "same");
  const fresh = emptyStore(); fresh.settings.profile_updated_at = T2;   // edited later, but nothing in it
  assert.equal(S.decide(fresh, server(other, T1)), "restore");
  const partial = filled({ onboarded: false, updated: T2 });
  assert.equal(S.decide(partial, server(other, T1)), "restore");         // the account has a finished Deep Dive
  const otherPartial = filled({ onboarded: false }); otherPartial.profile.goals.career = "Other";
  assert.equal(S.decide(partial, server(otherPartial, T1)), "push");     // both unfinished: the newer one stays
  assert.equal(S.decide(filled(), { profile: null, updated: null }), "push");
  assert.equal(S.decide(emptyStore(), { profile: null, updated: null }), "none");
});

test("a resume replacement on a finished device: newer local edits are pushed, never restored over", async () => {
  const { autoApplyReady } = await import("../lib/store.js");
  const server = (s, updated) => ({ profile: S.toServer(S.syncedSubset(s)), updated });
  // The account holds the Deep Dive with the old resume's details (PR #94 review, P1 #2).
  const old = filled(); old.profile.experience = [{ title: "Old job" }];
  // This device finished the same Deep Dive, then the student replaced the resume (onboarding.js): the
  // new details are read in and still waiting for review, and the edit is newer than the account's copy.
  const local = filled({ updated: T1 }); local.profile.experience = [{ title: "Old job" }];
  local.settings.profile_synced_hash = S.hashOf(S.syncedSubset(local));
  Object.assign(local.settings, { resume_details_ready: false, resume_import: { plan: [] }, profile_updated_at: T2 });
  local.profile.experience = [{ title: "New job" }];
  assert.equal(local.settings.onboarded, true, "a replacement no longer unfinishes the Deep Dive");
  assert.equal(autoApplyReady(local), false, "Auto-Apply is paused by its own flag instead");
  assert.equal(S.decide(local, server(old, T1)), "push");
  // A store a PR #94 build left with onboarded=false still counts as finished: deep_dive_at says it was.
  const unfinished = structuredClone(local); unfinished.settings.onboarded = false;
  assert.equal(S.decide(unfinished, server(old, T1)), "push");
  // Through a real pull: the newer local copy goes up and nothing comes back down.
  reset(local);
  let put = null;
  routes = { "GET /profile": () => [200, server(old, T1)], "PUT /profile": (body) => { put = body; return [200, { updated: T2 }]; } };
  assert.equal((await S.syncNow()).state, "pushed");
  const after = await loadStore();
  assert.deepEqual(after.profile.experience, [{ title: "New job" }]);
  assert.deepEqual(put.profile.experience, [{ title: "New job" }]);
  assert.equal(after.settings.resume_details_ready, false);
  assert.equal(autoApplyReady(after), false, "still paused until the review is saved");
  // A copy that really is newer (another computer) still wins, and the pause here stays on.
  const elsewhere = filled(); elsewhere.profile.goals.career = "Edited on the laptop";
  const restored = structuredClone(local);
  assert.equal(S.decide(restored, server(elsewhere, T3)), "restore");
  S.applyServer(restored, server(elsewhere, T3).profile, T3);
  assert.equal(restored.settings.onboarded, true);
  assert.equal(autoApplyReady(restored), false);
});

test("a restore keeps where this device's self-identification answers came from", async () => {
  const { confirmedFacts } = await import("../lib/store.js");
  const { applyInterviewFacts } = await import("../onboarding/profile.js");
  const local = filled();
  Object.assign(local.profile.facts, { race: "Decline to self-identify", veteran: "I don't wish to answer" });
  applyInterviewFacts(local.profile, { race: "Asian", veteran: "I am a protected veteran" });
  const server = S.toServer(S.syncedSubset(filled()));
  assert.ok(!JSON.stringify(server).includes("protected veteran"));
  S.applyServer(local, server, T2);
  assert.equal(local.profile.facts.race, "Asian", "the suggestion is still there to review");
  assert.equal(local.profile.sources.facts.race.source, "interview");
  // was: the record was dropped, and an unrecorded answer counts as the student's own.
  assert.equal(confirmedFacts(local).race, "Decline to self-identify");
  assert.equal(confirmedFacts(local).veteran, "I don't wish to answer");
});

test("only real local edits are noticed", () => {
  const a = filled(), b = filled();
  b.profile.goals.career = "Robotics";
  assert.equal(S.isLocalEdit(a, b), true);
  assert.equal(S.isLocalEdit(undefined, b), false);             // the store being created
  const c = filled(); c.profile.facts.gender = "Man"; c.accounts = [];
  assert.equal(S.isLocalEdit(a, c), false);                     // demographics and logins aren't synced
  const d = filled(); d.settings.profile_synced_hash = "x";
  assert.equal(S.isLocalEdit(a, d), false);                     // bookkeeping only
  b.settings.profile_synced_hash = S.hashOf(S.syncedSubset(b));
  assert.equal(S.isLocalEdit(a, b), false);                     // a sync writing the account's copy
});

test("signing in on a new computer restores the Deep Dive, marks it finished and says so once", async () => {
  const fresh = emptyStore(); fresh.profile.facts.gender = "Non-binary";
  reset(fresh);
  const saved = S.toServer(S.syncedSubset(filled()));
  routes = { "GET /profile": () => [200, { profile: saved, updated: T2 }] };
  const r = await S.syncNow();
  assert.equal(r.state, "restored");
  assert.equal(calls[0].auth, "Bearer iss_live");
  const s = await loadStore();
  assert.equal(s.settings.onboarded, true);                     // popup, side panel and background let them through
  assert.equal(s.profile.facts.first_name, "Sam");
  assert.equal(s.profile.facts.gender, "Non-binary");
  assert.equal(s.settings.profile_updated_at, T2);
  assert.equal(s.settings.profile_synced_hash, S.hashOf(S.serverSubset(saved)));
  assert.equal(s.files.resume, null);                           // files never came from the account
  assert.equal(calls.filter((c) => c.key === "PUT /profile").length, 0);
  const note = await S.takeRestored();
  assert.equal(note.updated, T2);
  assert.match(S.restoredMessage(note), /^Restored your Deep Dive from your account \(saved Sep 2\d, 2026\)\.$/);
  assert.equal(await S.takeRestored(), null);                   // once
  // Pulling again changes nothing.
  assert.equal((await S.syncNow()).state, "same");
});

test("a newer local Deep Dive is pushed, and the time the Worker stored is what's kept", async () => {
  reset(filled({ updated: "2026-09-25T12:00:00.000Z" }));   // this device's clock runs fast
  const older = filled(); older.profile.goals.career = "Old";
  let stored = null;
  routes = {
    "GET /profile": () => (stored ? [200, stored] : [200, { profile: S.toServer(S.syncedSubset(older)), updated: T1 }]),
    // The Worker stores min(sent, its own now) and answers with that.
    "PUT /profile": (b) => { stored = { profile: b.profile, updated: "2026-09-25T11:00:00.000Z" }; return [200, { ok: true, updated: stored.updated }]; },
  };
  const r = await S.syncNow();
  assert.equal(r.state, "pushed");
  const put = calls.find((c) => c.key === "PUT /profile");
  assert.equal(put.body.updated, "2026-09-25T12:00:00.000Z");
  assert.equal(put.body.profile.facts.first_name, "Sam");
  for (const k of S.DEMOGRAPHIC_KEYS) assert.ok(!(k in put.body.profile.facts), k);
  let s = await loadStore();
  assert.equal(s.settings.profile_updated_at, "2026-09-25T11:00:00.000Z");   // the reply's time, not ours
  assert.equal(s.settings.profile_synced_hash, S.hashOf(S.syncedSubset(s)));
  // The next pull sees the same copy at the same time: nothing to do, not "ours is newer" forever.
  calls.length = 0;
  assert.equal((await S.syncNow()).state, "same");
  assert.deepEqual(calls.map((c) => c.key), ["GET /profile"]);
});

test("an edit is stamped with its own time and flushed, even after the worker was stopped", async () => {
  const s0 = filled({ updated: T1 });
  s0.settings.profile_synced_hash = S.hashOf(S.syncedSubset(s0));
  s0.profile.goals.career = "Edited";                          // the edit, noticed but not yet sent
  reset(s0);
  LOCAL[S.PENDING_KEY] = { dirty_at: "2026-09-25T09:00:00.000Z" };
  routes = { "PUT /profile": (b) => [200, { ok: true, updated: b.updated }] };
  const r = await S.flushPending();                             // what the worker does when it starts again
  assert.equal(r.state, "pushed");
  assert.deepEqual(calls.map((c) => c.key), ["PUT /profile"]);  // matched the account before: no pull first
  assert.equal(calls[0].body.updated, "2026-09-25T09:00:00.000Z");
  assert.equal(calls[0].body.profile.goals.career, "Edited");
  assert.equal(LOCAL[S.PENDING_KEY], undefined);
  assert.equal((await S.flushPending()).state, "none");
});

test("a first flush pulls before it pushes, so a fresh device never buries the account's copy", async () => {
  const fresh = emptyStore(); fresh.profile.facts.first_name = "S";   // typed before signing in
  reset(fresh);
  LOCAL[S.PENDING_KEY] = { dirty_at: new Date().toISOString() };
  routes = { "GET /profile": () => [200, { profile: S.toServer(S.syncedSubset(filled())), updated: T1 }], "PUT /profile": () => [200, { ok: true }] };
  const r = await S.flush();
  assert.equal(r.state, "restored");
  assert.deepEqual(calls.map((c) => c.key), ["GET /profile"]);
  assert.equal((await loadStore()).profile.facts.first_name, "Sam");
});

test("409: the account has a newer copy, which is applied here", async () => {
  const mine = filled({ updated: T1 }); mine.settings.profile_synced_hash = "stale";
  reset(mine);
  const theirs = filled(); theirs.profile.goals.career = "Newer elsewhere";
  routes = { "PUT /profile": () => [409, { error: "stale", profile: S.toServer(S.syncedSubset(theirs)), updated: T2 }] };
  const r = await S.flush();
  assert.equal(r.state, "restored");
  const s = await loadStore();
  assert.equal(s.profile.goals.career, "Newer elsewhere");
  assert.equal(s.profile.facts.gender, "Woman");                // still this device's answer
  assert.equal(s.settings.profile_updated_at, T2);
});

test("sync_off, an older Worker, signed out or switched off: silently nothing", async () => {
  for (const [status, reply] of [[503, { error: "sync_off", message: "Saving profiles isn't turned on yet." }], [404, { error: "not_found" }]]) {
    const s0 = filled({ updated: T1 });
    reset(s0);
    routes = { "GET /profile": () => [status, reply] };
    const r = await S.syncNow();
    assert.equal(r.state, "unavailable", String(status));
    assert.deepEqual(calls.map((c) => c.key), ["GET /profile"]);
    const s = await loadStore();
    assert.equal(s.profile.goals.career, s0.profile.goals.career);
    assert.equal(s.settings.profile_synced_hash, null);           // nothing recorded as synced
  }
  reset(filled(), { signedIn: false });
  assert.equal((await S.syncNow()).state, "signed_out");
  assert.equal(calls.length, 0);
  const off = filled(); off.settings.cloud_sync = false;
  reset(off);
  assert.equal((await S.syncNow()).state, "off");
  assert.equal(calls.length, 0);
  reset(filled());                                              // offline
  assert.equal((await S.syncNow()).state, "signed_out_or_offline");
});

test("the switch: off deletes the account's copy first; on sends this device's copy", async () => {
  reset(filled({ updated: T1, synced: "abc" }));
  routes = { "DELETE /profile": () => [200, { ok: true }] };
  assert.deepEqual(await S.setCloudSync(false), { ok: true });
  let s = await loadStore();
  assert.equal(s.settings.cloud_sync, false);
  assert.equal(s.settings.profile_synced_hash, null);
  // Can't delete (offline): stays on.
  reset(filled({ updated: T1 }));
  const r = await S.setCloudSync(false);
  assert.equal(r.ok, false);
  assert.equal((await loadStore()).settings.cloud_sync, true);
  // Back on: the account is empty now, so this device's copy goes up.
  const off = filled({ updated: T1 }); off.settings.cloud_sync = false;
  reset(off);
  routes = { "GET /profile": () => [200, { profile: null, updated: null }], "PUT /profile": (b) => [200, { ok: true, updated: b.updated }] };
  const on = await S.setCloudSync(true);
  assert.equal(on.ok, true); assert.equal(on.state, "pushed");
  s = await loadStore();
  assert.equal(s.settings.cloud_sync, true);
  assert.equal(s.settings.profile_synced_hash, S.hashOf(S.syncedSubset(s)));
});

test("new settings defaults reach an existing store through the normal merge", async () => {
  const old = emptyStore();
  for (const k of ["cloud_sync", "profile_updated_at", "profile_synced_hash"]) delete old.settings[k];
  reset(old, { signedIn: false });
  const s = await loadStore();
  assert.equal(s.settings.cloud_sync, true);
  assert.equal(s.settings.profile_updated_at, null);
  assert.equal(s.settings.profile_synced_hash, null);
});


test("learned answers to self-identification questions stay on the device, and survive a restore", async () => {
  const { syncedSubset, applyServer, withoutDemographicAnswers } = await import("../lib/sync.js");
  const { emptyStore } = await import("../lib/store.js");
  const s = emptyStore();
  s.profile.extra = {
    "What is your gender identity?": "Woman",
    "Are you Hispanic or Latino?": "No",
    "Please select your veteran status": "Not a veteran",
    "Do you have a disability?": "No",
    "Voluntary self-identification of race": "Asian",
    "Why do you want to work here?": "The mission",
    "Desired start date": "June 2027",
  };
  const up = syncedSubset(s).profile.extra;
  assert.deepEqual(up, { "Why do you want to work here?": "The mission", "Desired start date": "June 2027" });
  assert.deepEqual(withoutDemographicAnswers(undefined), {});
  // The account's copy (no demographic answers) is restored over this device: ours are kept.
  applyServer(s, { extra: { "Why do you want to work here?": "Growth", "Leaked: gender": "x" } }, "2026-09-26T12:00:00.000Z");
  assert.equal(s.profile.extra["Why do you want to work here?"], "Growth");
  assert.equal(s.profile.extra["What is your gender identity?"], "Woman");
  assert.equal(s.profile.extra["Do you have a disability?"], "No");
  assert.ok(!("Leaked: gender" in s.profile.extra), "a demographic entry from the server is not taken");
  assert.ok(!("Desired start date" in s.profile.extra), "non-demographic entries come from the account's copy");
});

// 2026-10-23: delayed restores preserve concurrent manual edits, including a PUT conflict (EXT-3).
for (const kind of ["GET", "PUT"]) test(`${kind} restore cannot overwrite a newer local edit`, async () => {
  const initial = filled({ updated: T1, synced: kind === "PUT" ? "old-hash" : null });
  reset(initial);
  let release, reached;
  const pending = new Promise(r => { reached = r; });
  const gate = new Promise(r => { release = r; });
  const remote = S.toServer(S.syncedSubset(filled()));
  remote.goals.career = "Earlier remote edit";
  routes[`${kind} /profile`] = async () => {
    reached(); await gate;
    return [kind === "PUT" ? 409 : 200, { profile: remote, updated: T2 }];
  };
  const operation = kind === "PUT" ? S.flush() : S.syncNow();
  await pending;
  const { updateStore } = await import("../lib/store.js");
  await updateStore(s => { s.profile.goals.career = "My newer manual edit"; s.settings.profile_updated_at = T3; });
  LOCAL[S.PENDING_KEY] = { dirty_at: T3 };
  release();
  assert.equal((await operation).state, "local_changed");
  const after = await loadStore();
  assert.equal(after.profile.goals.career, "My newer manual edit");
  assert.equal(after.settings.profile_updated_at, T3);
  assert.equal(after.settings.profile_synced_hash, initial.settings.profile_synced_hash);
  assert.deepEqual(LOCAL[S.PENDING_KEY], { dirty_at: T3 });
  assert.equal(LOCAL[S.RESTORED_KEY], undefined, "no misleading restored notice");
});

test("an edit arriving while an older pending marker is read survives stamping and remote comparison", async () => {
  reset(filled({ updated: T1 }));
  LOCAL[S.PENDING_KEY] = { dirty_at: T1 };
  const originalGet = chrome.storage.local.get, began = deferred(), release = deferred();
  let first = true;
  chrome.storage.local.get = async k => {
    const result = await originalGet(k);
    if (k === S.PENDING_KEY && first) { first = false; began.resolve(); await release.promise; }
    return result;
  };
  const remote = S.toServer(S.syncedSubset(filled()));
  remote.goals.career = "Older remote edit";
  routes = {
    "GET /profile": () => [200, { profile: remote, updated: T2 }],
    "PUT /profile": body => [200, { ok: true, updated: body.updated }],
  };
  const { updateStore } = await import("../lib/store.js");
  try {
    const syncing = S.syncNow();
    await began.promise;
    const editing = updateStore(s => { s.profile.goals.career = "My newest manual edit"; });
    const noting = editing.then(() => S.noteEdit());
    release.resolve();
    await Promise.all([syncing, noting]);
    const after = await loadStore();
    assert.equal(after.profile.goals.career, "My newest manual edit");
    assert.ok(Date.parse(after.settings.profile_updated_at) > Date.parse(T2));
    assert.ok(LOCAL[S.PENDING_KEY], "the newly noted edit remains pending");
  } finally {
    chrome.storage.local.get = originalGet;
    await S.forgetSynced(); // clear the real debounce timer
  }
});

test("a revision stamped after the GET snapshot prevents an older restore even when the profile hash is unchanged", async () => {
  reset(filled({ updated: T1 }));
  const began = deferred(), release = deferred();
  const remote = S.toServer(S.syncedSubset(filled()));
  remote.goals.career = "Older remote edit";
  routes = { "GET /profile": async () => { began.resolve(); await release.promise; return [200, { profile: remote, updated: T2 }]; } };
  const syncing = S.syncNow();
  await began.promise;
  await S.noteEdit();
  release.resolve();
  assert.equal((await syncing).state, "local_changed");
  assert.equal((await loadStore()).profile.goals.career, "");
  assert.ok(LOCAL[S.PENDING_KEY]);
  await S.forgetSynced();
});

test("a failed revision write keeps the pending marker for a later retry", async () => {
  reset(filled({ updated: T1 }));
  LOCAL[S.PENDING_KEY] = { dirty_at: T3 };
  const originalSet = chrome.storage.local.set;
  let fail = true;
  chrome.storage.local.set = async o => {
    if (o.store && fail) { fail = false; throw new Error("synthetic storage failure"); }
    return originalSet(o);
  };
  try {
    await assert.rejects(S.syncNow(), /synthetic storage failure/);
    assert.deepEqual(LOCAL[S.PENDING_KEY], { dirty_at: T3 });
    assert.equal((await loadStore()).settings.profile_updated_at, T1);
    assert.equal(calls.length, 0);
  } finally { chrome.storage.local.set = originalSet; }
});
