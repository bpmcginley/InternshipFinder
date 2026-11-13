// 2026-10-23: protect the employer offer, honest illustration and availability-gated buying path.
// was: the sales page had only a presentation-specific regex in buy.test.mjs.
// Revert: remove this file when reverting the sales presentation and shared purchase-link gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const PAGE = readFileSync(new URL("../../docs/employers/index.html", import.meta.url), "utf8");
const clean = PAGE.replace(/<!--[\s\S]*?-->/g, "");
const main = clean.match(/<main>([\s\S]*?)<\/main>/)[1];
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const body = text(main);
const inline = clean.match(/<script>([\s\S]*?)<\/script>/)[1];
const gate = inline.slice(0, inline.indexOf("// The interest form."));
const API = "https://internscout-api.bpmcginley.workers.dev/employer/config";

async function availability(response, { ok = true, rejected = false, noFetch = false } = {}) {
  const boxes = [...main.matchAll(/<div\b[^>]*data-employer-buy\b[^>]*>/g)].map(() => ({ hidden: true }));
  const fallback = { hidden: false };
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    if (rejected) throw new Error("offline");
    return { ok, json: async () => response };
  };
  vm.runInNewContext(gate, {
    window: noFetch ? {} : { fetch }, fetch,
    document: {
      querySelectorAll(selector) { assert.equal(selector, "[data-employer-buy]"); return boxes; },
      getElementById(id) { assert.equal(id, "buy-unavailable"); return fallback; },
    },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { boxes, fallback, calls };
}

test("the employer hero leads with the fixed one-role offer and a choose-role action", () => {
  const hero = main.match(/<section class="sales-hero"[\s\S]*?<\/section>/)[0];
  assert.match(text(hero), /\$29 per role for 30 days/);
  assert.match(hero, /href="\/employers\/buy\/" data-employer-entry="hero">Choose a role<\/a>/);
  assert.match(text(hero), /US dollars\. One payment\. No automatic renewal\./);
  assert.ok(main.indexOf('class="sales-hero"') < main.indexOf('id="packages"'));
  assert.equal((main.match(/<h1\b/g) || []).length, 1);
});

test("packages preserve standard and public-body prices and describe the limited pilot honestly", () => {
  const one = main.match(/<article class="package" aria-labelledby="one-title">([\s\S]*?)<\/article>/)[1];
  const three = main.match(/<article class="package" aria-labelledby="three-title">([\s\S]*?)<\/article>/)[1];
  assert.match(text(one), /\$29 for 30 days/);
  assert.match(text(one), /Nonprofits, government and public university programs: \$15/);
  assert.match(text(three), /\$69 for three roles/);
  assert.match(text(three), /30 days each/);
  assert.match(text(three), /Nonprofits, government and public university programs: \$35 for three/);
  assert.match(body, /First-five employer pilot: one role free for 30 days/);
  assert.match(body, /Ask about availability and a pilot code before ordering/);
});

test("the ad preview is a noninteractive illustration without invented hiring facts", () => {
  const preview = main.match(/<figure class="ad-preview"[\s\S]*?<\/figure>/)[0];
  assert.match(text(preview), /Paid listing Illustrative preview Ad Your company name/);
  assert.match(text(preview), /Your internship title/);
  assert.match(text(preview), /Illustration only, not a live role/);
  assert.doesNotMatch(preview, /<a\b|<button\b|<input\b|\$\d|\b\d+\s+(?:views|clicks|applicants)\b/);
});

test("every purchase action starts hidden while the contact fallback works without scripts", () => {
  const wrappers = [...main.matchAll(/<div\b[^>]*data-employer-buy\b[^>]*>/g)];
  assert.equal(wrappers.length, 3);
  assert.ok(wrappers.every(match => /\bhidden\b/.test(match[0])));
  assert.equal((main.match(/href="\/employers\/buy\/"/g) || []).length, 3);
  assert.match(clean, /\[hidden\]\{display:none!important\}/);
  assert.match(main, /<p id="buy-unavailable" class="availability">If online ordering is unavailable/);
  assert.match(main, /href="#interest" data-employer-entry="contact"/);
  const entries = [...main.matchAll(/data-employer-entry="([^"]+)"/g)].map(match => match[1]);
  assert.ok(entries.every(value => ["hero", "packages", "contact"].includes(value)));
});

test("the exact enabled flag reveals all purchase choices and hides the fallback", async () => {
  const r = await availability({ enabled: true });
  assert.ok(r.boxes.every(box => box.hidden === false));
  assert.equal(r.fallback.hidden, true);
  assert.deepEqual(r.calls, [{ url: API, options: undefined }]);
});

test("disabled, malformed, failed and unsupported configs keep buying closed", async () => {
  for (const [cfg, options] of [
    [{ enabled: false }, {}], [{ enabled: "true" }, {}], [{ enabled: 1 }, {}], [{}, {}],
    [null, {}], [{ enabled: true }, { ok: false }], [null, { rejected: true }], [null, { noFetch: true }],
  ]) {
    const r = await availability(cfg, options);
    assert.ok(r.boxes.every(box => box.hidden === true));
    assert.equal(r.fallback.hidden, false);
  }
});

test("free requests and paid listing limits remain explicit", () => {
  assert.match(main, /id="free-help" aria-labelledby="free-title"/);
  assert.match(body, /Board additions and corrections are always free, with no purchase required/);
  assert.match(body, /This form does not buy anything/);
  assert.match(body, /Paying never changes where any listing ranks/);
  assert.match(body, /Auto-Apply works the same for every listing, paid or not/);
  assert.match(body, /at most one paid listing on a page/);
  assert.match(body, /We do not promise views, clicks or applicants/);
  assert.match(body, /We do not see applications, so we cannot count or attribute them/);
  assert.match(body, /Each has the same chance|each has the same chance/);
  assert.match(body, /cannot approve your order, you get a full refund/);
  assert.match(body, /cancel by email for a full refund before approval/);
  assert.match(main, /href="\/terms#employers"/);
  assert.match(main, /href="\/privacy#paid-listings"/);
  assert.doesNotMatch(body, /[\u2013\u2014]|guaranteed applicants|priority ranking|automatic renewal enabled/i);
});

test("the contact form keeps required fields, free options, privacy and bot protection", () => {
  assert.match(main, /<form class="lead" id="lead" novalidate aria-labelledby="interest">/);
  for (const [field, limit] of [["name", 100], ["email", 254], ["company", 120]]) {
    assert.match(main, new RegExp(`<input id="${field}"[^>]*required maxlength="${limit}"`));
  }
  for (const value of ["placement", "board", "details", "other"]) {
    assert.match(main, new RegExp(`name="wants" value="${value}"`));
  }
  assert.match(main, /class="hp" aria-hidden="true"/);
  assert.match(main, /id="website" name="website" type="text" tabindex="-1" autocomplete="off"/);
  assert.match(main, /id="status" role="alert"/);
  assert.match(main, /href="\/privacy#employers"/);
  assert.match(inline, /\/employer-interest"/);
  assert.match(inline, /form\.addEventListener\("submit"/);
});
