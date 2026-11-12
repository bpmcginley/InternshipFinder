import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  dashboardFollowSelection,
  dashboardFollowSession,
  createDashboardFollowRequest,
  createDashboardFollow,
} from "../../docs/js/app/follow.mjs";
import { createFollowForm as publicForm } from "../../docs/js/follow-form.mjs";
import { createFollowForm as graphForm } from "../../docs/js/app/follow-form.mjs";

const IS = {
  ALL_KEY: "all",
  fieldLabel: (key) => `Field ${key}`,
  keyLabel: (key) => `State ${key}`,
  authOk: (who) => who.exp > Date.now() + 60000,
};
const selection = dashboardFollowSelection({ fields: ["swe"], states: ["MA"] }, IS);
const input = {
  email: "synthetic@example.test",
  link: false,
  scope: { kind: "search", fields: ["swe"], states: ["MA"] },
};
function fixture(extra = {}) {
  const token = `iss_${randomBytes(32).toString("base64url")}`;
  let state = {
    generation: 1,
    auth: { token, who: { token, session: true, exp: Date.now() + 3600000 } },
  };
  const calls = [],
    timers = new Map();
  let elapsed = 0;
  const browser = {
    IS,
    Date,
    AbortController,
    performance: { now: () => elapsed },
    setTimeout: (fn) => {
      timers.set(1, fn);
      return 1;
    },
    clearTimeout: (key) => timers.delete(key),
    fetch: async (...args) => {
      calls.push(args);
      return new Response(null, { status: 202 });
    },
    ...extra,
  };
  const request = createDashboardFollowRequest(browser, {
    enabled: true,
    selection,
    generation: 1,
    renderedToken: token,
    getAuth: () => state,
  });
  return {
    browser,
    request,
    calls,
    timers,
    token,
    state: () => state,
    update: (next) => {
      state = next;
    },
    time: (value) => {
      elapsed = value;
    },
  };
}

test("compatibility export preserves the same form API; shipped dashboard release switch is absent", () => {
  assert.equal(publicForm, graphForm);
  assert.doesNotMatch(readFileSync("docs/index.html", "utf8"), /data-follow-signup-enabled/);
  for (const flag of [null, "true", "false", "0"]) {
    const component = createDashboardFollow({
      React: {},
      document: { documentElement: { getAttribute: () => flag } },
    });
    assert.equal(component({}), null);
  }
});
test("explicit dimensions are sorted and deduplicated; other filters and profile are never copied", () => {
  const result = dashboardFollowSelection(
    {
      fields: ["swe", "future_field", "swe"],
      states: ["TX", "MA", "TX"],
      q: "private search",
      company: ["anything"],
      year: "senior",
      profile: { states: ["CA"] },
    },
    IS,
  );
  assert.deepEqual(
    result.fields.map((v) => v.key),
    ["future_field", "swe"],
  );
  assert.deepEqual(
    result.states.map((v) => v.key),
    ["MA", "TX"],
  );
  assert.deepEqual(Object.keys(result), ["kind", "fields", "states"]);
  assert.deepEqual(
    dashboardFollowSelection({ fields: ["legacy_alias"], states: ["all"] }, IS).states,
    [],
  );
  assert.equal(dashboardFollowSelection({ fields: [], states: ["all"] }, IS), null);
  assert.equal(
    dashboardFollowSelection({ fields: [], states: [], profile: { states: ["MA"] } }, IS),
    null,
  );
});
test("unsupported and over-limit selections fail as a whole, without truncating or broadening", () => {
  for (const states of [
    ["remote"],
    ["Canada"],
    ["all", "MA"],
    ["MA", "remote"],
    ["ma"],
    ["MA\n"],
    [null],
  ])
    assert.equal(dashboardFollowSelection({ fields: ["swe"], states }, IS), null);
  for (const fields of [["valid", "bad field"], ["x"], [null], new Array(1), Array(81).fill("swe")])
    assert.equal(dashboardFollowSelection({ fields, states: ["MA"] }, IS), null);
  const keys = Array.from(
    { length: 66 },
    (_, n) =>
      `field_${String.fromCharCode(97 + Math.floor(n / 26))}${String.fromCharCode(97 + (n % 26))}`,
  );
  assert.equal(
    dashboardFollowSelection({ fields: keys.slice(0, 64), states: [] }, IS).fields.length,
    64,
  );
  for (const n of [65, 66])
    assert.equal(dashboardFollowSelection({ fields: keys.slice(0, n), states: [] }, IS), null);
});
test("anonymous request excludes authorization even when a native session exists", async () => {
  const f = fixture();
  assert.deepEqual(await f.request(input), { status: "accepted" });
  assert.equal(f.calls.length, 1);
  const [url, options] = f.calls[0];
  assert.equal(url, "https://internscout-api.bpmcginley.workers.dev/follows/signup");
  assert.deepEqual(JSON.parse(options.body), input);
  assert.deepEqual(options.headers, { "Content-Type": "application/json" });
  for (const [key, value] of Object.entries({
    method: "POST",
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    mode: "cors",
    referrerPolicy: "no-referrer",
  }))
    assert.equal(options[key], value);
  assert.equal(f.timers.size, 0);
});
test("explicit linking requires exact current native session and unchanged generation", async () => {
  const f = fixture();
  assert.equal(dashboardFollowSession(f.state().auth, IS), true);
  assert.equal((await f.request({ ...input, link: true })).status, "accepted");
  assert.equal(f.calls[0][1].headers.Authorization, `Bearer ${f.token}`);
  for (const bad of [
    null,
    { token: "jwt", who: { session: false } },
    { token: f.token, who: { token: f.token, session: true, exp: 0 } },
    { token: f.token + "x", who: { token: f.token, session: true, exp: Date.now() + 3600000 } },
  ]) {
    const x = fixture();
    x.update({ generation: 1, auth: bad });
    assert.equal((await x.request({ ...input, link: true })).status, "unavailable");
    assert.equal(x.calls.length, 0);
  }
  f.update({ ...f.state(), generation: 2 });
  assert.equal((await f.request(input)).status, "unavailable");
  assert.equal(f.calls.length, 1);
});
test("disabled, changed scope and aborted requests make no API call", async () => {
  const f = fixture(),
    controller = new AbortController();
  controller.abort();
  assert.equal((await createDashboardFollowRequest(f.browser, {})(input)).status, "unavailable");
  assert.equal(
    (await f.request({ ...input, scope: { ...input.scope, states: [] } })).status,
    "unavailable",
  );
  assert.equal((await f.request(input, { signal: controller.signal })).status, "unavailable");
  assert.equal(f.calls.length, 0);
});
test("only HTTP 202 is accepted; server JSON and errors are never exposed or retried", async () => {
  for (const status of [200, 400, 401, 403, 404, 410, 415, 503]) {
    let calls = 0;
    const f = fixture({
      fetch: async () => {
        calls++;
        return new Response('{"status":"accepted","detail":"private"}', { status });
      },
    });
    assert.deepEqual(await f.request(input), { status: "unavailable" });
    assert.equal(calls, 1);
  }
  const f = fixture({
    fetch: async () => {
      throw Error("private transport detail");
    },
  });
  assert.deepEqual(await f.request(input), { status: "unavailable" });
});
test("late success after identity change, expiry or elapsed deadline cannot become accepted", async () => {
  for (const change of [
    (f) => f.update({ ...f.state(), generation: 2 }),
    (f) => {
      f.state().auth.who.exp = 0;
    },
    (f) => f.time(12000),
    (f) => f.time(-1),
  ]) {
    let resolve;
    const f = fixture({
      fetch: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const pending = f.request({ ...input, link: true });
    change(f);
    resolve(new Response(null, { status: 202 }));
    assert.deepEqual(await pending, { status: "unavailable" });
  }
});
test("abort and absolute timeout settle even a noncooperative fetch with no retry", async () => {
  for (const stop of ["abort", "timeout"]) {
    let count = 0,
      inner;
    const f = fixture({
      fetch: (_, options) => {
        count++;
        inner = options.signal;
        return new Promise(() => {});
      },
    });
    const controller = new AbortController();
    const pending = f.request(input, { signal: controller.signal });
    if (stop === "abort") controller.abort();
    else f.timers.get(1)();
    assert.deepEqual(await pending, { status: "unavailable" });
    assert(inner.aborted);
    assert.equal(count, 1);
    assert.equal(f.timers.size, 0);
  }
});

test("same-token A to B to A generation change never reuses consent", async () => {
  let resolve;
  const f = fixture({
    fetch: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const original = f.state();
  const pending = f.request({ ...input, link: true });
  f.update({ generation: 2, auth: { token: "other" } });
  f.update({ ...original, generation: 3 });
  resolve(new Response(null, { status: 202 }));
  assert.equal((await pending).status, "unavailable");
});
test("live token must match rendered identity even if a faulty caller reuses generation", async () => {
  const f = fixture(),
    token = `iss_${randomBytes(32).toString("base64url")}`;
  f.update({
    generation: 1,
    auth: { token, who: { token, session: true, exp: Date.now() + 3600000 } },
  });
  assert.equal((await f.request({ ...input, link: true })).status, "unavailable");
  assert.equal(f.calls.length, 0);
});
test("success receipt must be empty and its read shares the absolute deadline", async () => {
  for (const body of ["{}", "accepted", " "]) {
    const f = fixture({ fetch: async () => new Response(body, { status: 202 }) });
    assert.equal((await f.request(input)).status, "unavailable");
  }
  let reading;
  const ready = new Promise((resolve) => {
    reading = resolve;
  });
  let cancelled = 0;
  const body = new ReadableStream({
    pull() {
      reading();
      return new Promise(() => {});
    },
    cancel() {
      cancelled++;
    },
  });
  const f = fixture({ fetch: async () => new Response(body, { status: 202 }) });
  const pending = f.request(input);
  await ready;
  await new Promise((resolve) => setImmediate(resolve));
  f.timers.get(1)();
  assert.equal((await pending).status, "unavailable");
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
});
