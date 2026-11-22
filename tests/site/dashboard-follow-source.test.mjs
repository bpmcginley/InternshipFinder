import test from "node:test";
import assert from "node:assert/strict";
import { createFollowSource } from "../../docs/js/app/follow-source.mjs";
import { dashboardFollowSelection } from "../../docs/js/app/follow.mjs";
import { createAccount } from "../../docs/js/core/account.mjs";
import { randomBytes } from "node:crypto";
import { createProfile } from "../../docs/js/core/profile.mjs";

function fixture(search, enabled = true) {
  const browser = {
    URLSearchParams,
    Date,
    location: new URL("https://internscout.org/" + search),
    document: { documentElement: { getAttribute: () => (enabled ? "1" : null) } },
    history: {
      state: { existing: "kept" },
      replaceState(state, _, href) {
        this.state = structuredClone(state);
        browser.location = new URL(href, browser.location);
      },
    },
  };
  const IS = createProfile(browser);
  return {
    browser,
    IS,
    filters: () => IS.filtersFromUrl(browser.location.search),
    source: () => createFollowSource(browser),
  };
}
const cases = [
  "?field=swe&state=bad",
  "?field=swe,bad%20field&state=MA",
  "?field=swe&state=MA&state=remote",
  "?field=swe&state=" + [...Array(80).fill("MA"), "remote"].join(","),
  "?field=swe&field=finance&state=MA",
  "?field=swe,&state=MA",
  "?field=&state=MA",
  "?field=" + "a".repeat(8193) + "&state=MA",
];
test("actual Core lossy parsing never clears raw ambiguity, including reload after normalization", () => {
  for (const query of cases) {
    const f = fixture(query),
      source = f.source(),
      filters = f.filters();
    assert.equal(source.allowed(filters), false, query.slice(0, 80));
    assert.equal(source.canNormalize(), true);
    f.browser.history.replaceState(
      f.browser.history.state,
      "",
      "?field=" + filters.fields.join(",") + "&state=" + filters.states.join(","),
    );
    assert.equal(source.allowed(filters), false);
    assert.equal(f.source().allowed(f.filters()), false, "reloaded canonical URL stays blocked");
    assert.equal(f.browser.history.state.existing, "kept");
    const marker = f.browser.history.state.internscoutFollowAmbiguity;
    assert.deepEqual(Object.keys(marker), ["fields", "states"]);
    assert(Object.values(marker).every((value) => typeof value === "boolean"));
  }
});
test("only the explicitly corrected dimension clears its ambiguity", () => {
  const f = fixture("?field=swe,bad%20field&state=bad"),
    source = f.source();
  const filters = f.filters();
  source.correct("q", "unrelated");
  assert.equal(source.allowed(filters), false);
  source.correct("fields", ["swe"]);
  assert.equal(source.allowed(filters), false);
  assert.deepEqual(f.browser.history.state.internscoutFollowAmbiguity, {
    fields: false,
    states: true,
  });
  source.correct("states", ["MA"]);
  filters.states = ["MA"];
  assert.equal(source.allowed(filters), true);
  assert.deepEqual(f.browser.history.state, { existing: "kept" });
});
test("navigation restores its own entry flags and rejects a different URL from rendered chips", () => {
  const f = fixture("?field=swe&state=bad"),
    source = f.source();
  const blocked = structuredClone(f.browser.history.state);
  f.browser.location = new URL("https://internscout.org/?field=finance&state=MA");
  f.browser.history.state = { existing: "second" };
  source.navigate();
  assert.equal(source.allowed({ fields: ["swe"], states: ["MA"] }), false);
  assert.equal(source.allowed(f.filters()), true);
  f.browser.location = new URL("https://internscout.org/?field=swe");
  f.browser.history.state = blocked;
  source.navigate();
  assert.equal(source.allowed(f.filters()), false);
});
test("failed marker writes prevent lossy URL normalization, while disabled mount never touches history", () => {
  const f = fixture("?field=swe&state=bad");
  f.browser.history.replaceState = () => {
    throw Error("blocked");
  };
  const source = f.source();
  assert.equal(source.allowed(f.filters()), false);
  assert.equal(source.canNormalize(), false);
  const off = fixture("?field=swe&state=bad", false);
  Object.defineProperty(off.browser.history, "state", {
    get() {
      throw Error("must not read");
    },
  });
  const dormant = off.source();
  assert.equal(dormant.allowed({}), true);
  assert.equal(dormant.canNormalize(), true);
  dormant.correct("fields", []);
  dormant.navigate();
});
test("valid unknown keys preserve exact scope with real Core's non-string inherited labels", () => {
  const f = fixture("?field=constructor,__proto__,future_tag&state=MA");
  const selection = dashboardFollowSelection(f.filters(), f.IS);
  assert.equal(f.source().allowed(f.filters()), true);
  assert.deepEqual(
    selection.fields.map((value) => value.key),
    ["__proto__", "constructor", "future_tag"],
  );
  assert.deepEqual(
    selection.fields.slice(0, 2).map((value) => value.label),
    ["__proto__", "constructor"],
  );
});

test("auth history reset is repaired immediately before normalization and non-record history is preserved", () => {
  const f = fixture("?field=swe&state=bad"),
    source = f.source();
  f.browser.history.replaceState(null, "", f.browser.location.pathname + f.browser.location.search);
  assert.equal(source.canNormalize(), true);
  f.browser.history.replaceState(f.browser.history.state, "", "?field=swe");
  assert.equal(f.source().allowed(f.filters()), false);
  for (const state of [
    new Date(),
    new Map([["keep", "value"]]),
    new Set(["keep"]),
    ["keep"],
    "keep",
  ]) {
    const x = fixture("?field=swe&state=bad");
    x.browser.history.state = state;
    const boundary = x.source();
    assert.equal(boundary.canNormalize(), false);
    assert.equal(x.browser.history.state, state);
  }
});

test("actual successful Core callback cannot erase ambiguity while session exchange is awaited", async () => {
  const f = fixture("?field=swe&state=bad"),
    source = f.source();
  const storage = () => {
    const values = new Map();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, String(value)),
      removeItem: (key) => values.delete(key),
    };
  };
  Object.assign(f.browser, {
    localStorage: storage(),
    sessionStorage: storage(),
    AbortController,
    setTimeout,
    clearTimeout,
    TextDecoder,
    atob,
  });
  const profile = createProfile(f.browser);
  profile.ss.set("internscout.auth.state", "synthetic-state");
  profile.ss.set("internscout.auth.nonce", "synthetic-nonce");
  const payload = Buffer.from(
    JSON.stringify({
      sub: "synthetic",
      nonce: "synthetic-nonce",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url");
  f.browser.location.hash = "id_token=synthetic." + payload + ".synthetic&state=synthetic-state";
  let release,
    sessionCalls = 0;
  f.browser.fetch = async (url) => {
    if (!url.endsWith("/session")) return new Response(null, { status: 204 });
    sessionCalls++;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const account = createAccount(f.browser, {
    ...profile,
    C: { workerUrl: "https://synthetic.test" },
  });
  const pending = account.handleRedirect();
  assert.equal(f.browser.history.state, null);
  assert.equal(source.canNormalize(), true);
  f.browser.history.replaceState(f.browser.history.state, "", "?field=swe");
  const token = "iss_" + randomBytes(32).toString("base64url");
  release(
    new Response(
      JSON.stringify({ session: token, expires: new Date(Date.now() + 3600000).toISOString() }),
    ),
  );
  assert.equal((await pending).token, token);
  assert.equal(sessionCalls, 1);
  assert.equal(f.source().allowed(f.filters()), false);
});
