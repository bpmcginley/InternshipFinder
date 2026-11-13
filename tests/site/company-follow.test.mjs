import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { companyFollowSelection, createCompanyFollow } from "../../docs/js/app/follow.mjs";
import { createListings } from "../../docs/js/core/listings.mjs";

const role = () => ({
  id: "a".repeat(16),
  company_name: "The Example Corporation",
  follow_company_key: "example",
  status: "open",
});
function fixture(enabled = true) {
  const row = role(),
    index = { files: {} },
    ref = { current: { revision: 0 } },
    calls = [];
  const token = "iss_" + randomBytes(32).toString("base64url");
  let current = { row, index, legacy: false, active: true, authoritative: true, revision: 1 },
    state = {
      generation: 1,
      auth: { token, who: { token, session: true, exp: Date.now() + 3600000 } },
    };
  const browser = {
    React: { createElement: (type, props) => ({ type, props }), useRef: () => ref },
    document: { documentElement: { getAttribute: () => (enabled ? "1" : null) } },
    IS: { authOk: (who) => who.exp > Date.now() + 60000 },
    Date,
    AbortController,
    performance,
    setTimeout,
    clearTimeout,
    fetch: async (...args) => {
      calls.push(args);
      return new Response(null, { status: 202 });
    },
  };
  const Mount = createCompanyFollow(browser);
  const render = () => Mount({ row, ...state, getAuth: () => state, getCurrent: () => current });
  return {
    row,
    browser,
    calls,
    render,
    current: (value) => (current = value),
    state: (value) => (state = value),
    initial: state,
    index,
  };
}

test("dedicated own identity and exact current open row only, without normalization", () => {
  const row = role(),
    current = { row, index: {}, legacy: false, active: true, authoritative: true, revision: 1 };
  assert.deepEqual(companyFollowSelection(row, current), {
    kind: "company",
    company: { key: "example", label: "The Example Corporation" },
  });
  for (const next of [
    { ...current, row: { ...row } },
    { ...current, index: null },
    { ...current, legacy: true },
    { ...current, active: false },
    { ...current, authoritative: false },
  ])
    assert.equal(companyFollowSelection(row, next), null);
  for (const edit of [
    { follow_company_key: undefined },
    { follow_company_key: " example" },
    { follow_company_key: "x".repeat(201) },
    { follow_company_key: "é".repeat(101) },
    { follow_company_key: "bad\nkey" },
    { company_name: "" },
    { company_name: "x".repeat(201) },
    { id: 123 },
    { id: "unknown" },
    { status: "closed" },
    { _savedMissing: true },
  ]) {
    const value = { ...row, ...edit };
    assert.equal(companyFollowSelection(value, { ...current, row: value }), null);
  }
  const inherited = Object.assign(Object.create({ follow_company_key: "example" }), row);
  delete inherited.follow_company_key;
  assert.equal(companyFollowSelection(inherited, { ...current, row: inherited }), null);
  const counter = { ...row, employer_key: "example" };
  delete counter.follow_company_key;
  assert.equal(companyFollowSelection(counter, { ...current, row: counter }), null);
});

test("disabled mount does not inspect current source or invoke transport", () => {
  const f = fixture(false);
  f.current(null);
  assert.equal(f.render(), null);
  assert.equal(f.calls.length, 0);
});

test("normal company request reuses exact body-only transport and explicit link consent", async () => {
  const f = fixture();
  const view = f.render();
  const selected = view.props.selection;
  assert.equal(view.props.signedIn, true);
  const result = await view.props.request({
    email: "synthetic@example.test",
    link: true,
    scope: { kind: "company", company: selected.company.key },
  });
  assert.deepEqual(result, { status: "accepted" });
  assert.equal(f.calls.length, 1);
  const [url, options] = f.calls[0];
  assert.equal(new URL(url).pathname, "/follows/signup");
  assert.deepEqual(JSON.parse(options.body), {
    email: "synthetic@example.test",
    link: true,
    scope: { kind: "company", company: "example" },
  });
  assert.equal(options.headers.Authorization, "Bearer " + f.initial.auth.token);
  assert.equal(options.credentials, "omit");
});

test("stale/replaced/changed row or index is rejected before send and after awaited response", async () => {
  for (const change of [
    (f) =>
      f.current({
        row: { ...f.row },
        index: f.index,
        legacy: false,
        active: true,
        authoritative: true,
        revision: 1,
      }),
    (f) =>
      f.current({
        row: f.row,
        index: {},
        legacy: false,
        active: true,
        authoritative: true,
        revision: 1,
      }),
    (f) => (f.row.company_name = "Changed"),
    (f) => (f.row.follow_company_key = "changed"),
    (f) => (f.row.status = "closed"),
    (f) => (f.row.id = "b".repeat(16)),
    (f) =>
      f.current({
        row: f.row,
        index: f.index,
        legacy: false,
        active: false,
        authoritative: true,
        revision: 1,
      }),
    (f) =>
      f.current({
        row: f.row,
        index: f.index,
        legacy: false,
        active: true,
        authoritative: true,
        revision: 3,
      }),
  ]) {
    for (const delayed of [false, true]) {
      const f = fixture();
      const view = f.render();
      let resolve;
      f.browser.fetch = async () => {
        f.calls.push(true);
        return new Promise((r) => (resolve = r));
      };
      if (!delayed) change(f);
      const pending = view.props.request({
        email: "synthetic@example.test",
        link: false,
        scope: { kind: "company", company: "example" },
      });
      if (delayed) {
        change(f);
        resolve(new Response(null, { status: 202 }));
      }
      assert.deepEqual(await pending, { status: "unavailable" });
      assert.equal(f.calls.length, delayed ? 1 : 0);
    }
  }
});

test("auth A-B-A generation, unmount abort and malformed response never produce success", async () => {
  for (const kind of ["auth", "abort", "response"]) {
    const f = fixture();
    const view = f.render();
    let resolve;
    f.browser.fetch = async () => new Promise((r) => (resolve = r));
    const controller = new AbortController();
    const pending = view.props.request(
      {
        email: "synthetic@example.test",
        link: true,
        scope: { kind: "company", company: "example" },
      },
      { signal: controller.signal },
    );
    if (kind === "auth") f.state({ ...f.initial, generation: 3 });
    if (kind === "abort") controller.abort();
    resolve(
      new Response(kind === "response" ? "{}" : null, { status: kind === "response" ? 200 : 202 }),
    );
    assert.deepEqual(await pending, { status: "unavailable" });
  }
});

test("actual Core store preserves staged row provenance and separates reload generations", async () => {
  const row = role(),
    index = { files: { MA: { file: "listings/MA.json" } } };
  const browser = {
    AbortController,
    TextDecoder,
    Date,
    setTimeout,
    clearTimeout,
    console,
    fetch: async (url) => new Response(JSON.stringify(url.endsWith("index.json") ? index : [row])),
  };
  const { createStore } = createListings(browser, {
    C: { dataUrl: "https://fixture.test/data/" },
    fieldLabel: (value) => value,
  });
  const store = createStore();
  await store.init();
  await store.ensure(["MA"]);
  const original = store.all()[0],
    firstIndex = store.index();
  assert.equal(original.follow_company_key, "example");
  assert(
    companyFollowSelection(original, {
      active: true,
      authoritative:
        store.base() === "https://fixture.test/data/" && store.index()._dir === "listings/",
      revision: 1,
      row: original,
      index: firstIndex,
      legacy: store.isLegacy(),
    }),
  );
  await store.init();
  await store.ensure(["MA"]);
  assert.notEqual(store.index(), firstIndex);
  assert.notEqual(store.all()[0], original);
  assert.equal(
    companyFollowSelection(original, {
      row: store.all()[0],
      index: store.index(),
      legacy: false,
      active: true,
      authoritative: true,
      revision: 1,
    }),
    null,
  );
});

test("actual sharded root/raw fallbacks remain ineligible even when isLegacy is false", async () => {
  for (const fallback of ["root", "raw"]) {
    const primary = "https://fixture.test/data/",
      raw = "https://raw.fixture.test/data/";
    const browser = {
      AbortController,
      TextDecoder,
      Date,
      setTimeout,
      clearTimeout,
      console,
      fetch: async (url) => {
        if (url.endsWith("index.json")) {
          const match =
            fallback === "root"
              ? url === primary + "index.json"
              : url === raw + "listings/index.json";
          return new Response(
            match ? JSON.stringify({ files: { MA: { file: "listings/MA.json" } } }) : null,
            { status: match ? 200 : 404 },
          );
        }
        return new Response(JSON.stringify([role()]));
      },
    };
    const { createStore } = createListings(browser, {
      C: { dataUrl: primary, rawDataFallback: raw },
      fieldLabel: (x) => x,
    });
    const store = createStore();
    await store.init();
    await store.ensure(["MA"]);
    assert.equal(store.isLegacy(), false);
    const row = store.all()[0];
    assert.equal(
      companyFollowSelection(row, {
        row,
        index: store.index(),
        legacy: false,
        active: true,
        revision: 1,
        authoritative: store.base() === primary && store.index()._dir === "listings/",
      }),
      null,
    );
  }
});
