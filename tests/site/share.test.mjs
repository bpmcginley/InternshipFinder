import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const origin = "https://internscout.org";
const browser = { window: { addEventListener() {} }, URL, URLSearchParams };
vm.createContext(browser);
for (const file of ["core", "share"]) {
  vm.runInContext(
    readFileSync(new URL(`../../docs/js/${file}.js`, import.meta.url), "utf8"),
    browser,
  );
}
const { landingViews, searchLink } = browser.window.ISShare;
const { filterParams, filtersFromUrl } = browser.window.IS;
const views = landingViews({
  textContent: JSON.stringify({
    "swe/all": "/internships/software-engineering/",
    "swe/MA": "/internships/software-engineering/massachusetts/",
    "/MA": "/internships/massachusetts/",
  }),
});
const national = { all: true, keys: [], noRemote: false };
const initial = { fields: [], company: [], q: "", status: "open", sort: "new" };
const available = { allLoaded: true, first: ["MA", "NY"], indexKeys: ["MA", "NY", "remote", "US"] };
const link = (f = {}, scope = national, a = available, manifest = views) =>
  searchLink({ ...initial, ...f }, scope, a, manifest, origin, filterParams);

test("uses only an emitted match for the public field and location", () => {
  assert.equal(link({ fields: ["swe"] }), origin + "/internships/software-engineering/");
  const ma = { all: false, keys: ["MA"], noRemote: false };
  assert.equal(link({}, ma), origin + "/internships/massachusetts/");
  assert.equal(
    link({ fields: ["swe"] }, ma),
    origin + "/internships/software-engineering/massachusetts/",
  );
  assert.equal(new URL(link({ fields: ["finance"] }, ma)).pathname, "/");
});

test("shares the actual first-state scope and profile-limited regions", () => {
  assert.equal(
    new URL(link({}, national, { ...available, allLoaded: false })).searchParams.get("state"),
    "MA,NY",
  );
  assert.equal(
    new URL(link({}, { ...national, noRemote: true })).searchParams.get("state"),
    "MA,NY",
  );
  assert.equal(link({}, national, { ...available, allLoaded: false, first: [] }), null);
});

test("falls back to a public filter URL when the generated page is broader", () => {
  const f = { fields: ["swe"], q: "C++", paid: "paid", sort: "score", admin: true };
  const url = new URL(link(f));
  assert.equal(url.pathname, "/");
  const received = filtersFromUrl(url.search);
  assert.deepEqual(Array.from(received.fields), ["swe"]);
  assert.equal(received.q, "C++");
  assert.equal(received.paid, "paid");
  assert.equal(received.hide_citizen, false);
  assert.equal(url.searchParams.has("admin"), false);
  assert.equal(url.searchParams.has("sort"), false);
});

test("keeps recipient profile settings from narrowing a shared dashboard search", () => {
  const url = new URL(link());
  assert.equal(url.searchParams.get("state"), "all");
  assert.equal(url.searchParams.get("paid"), "any");
  assert.equal(url.searchParams.get("citizen"), "show");
});

test("private eligibility and progress views do not produce share URLs", () => {
  assert.equal(link({ eligible: true }), null);
  assert.equal(link({ app_state: "applied" }), null);
});

test("missing or malformed landing data never shares an outside URL", () => {
  for (const textContent of ["invalid", "null", "[]"]) {
    const manifest = landingViews({ textContent });
    assert.equal(new URL(link({ fields: ["swe"] }, national, available, manifest)).pathname, "/");
  }
  for (const path of ["//other.example/a", "/internships/../", "/internships/swe/?q=one"]) {
    const url = new URL(link({ fields: ["swe"] }, national, available, { "swe/all": path }));
    assert.equal(url.origin, origin);
    assert.equal(url.pathname, "/");
  }
});
