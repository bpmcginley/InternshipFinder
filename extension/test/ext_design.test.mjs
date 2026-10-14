// The extension UI rows of the 2026-10-14 design review (D25 to D29): the job card and its button order,
// no em dashes in student-facing text, setup-only links hidden until setup is done, the "Ready to apply"
// card brought into view, and the entry buttons' names.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

globalThis.chrome = globalThis.chrome || { runtime: {}, storage: { local: {}, session: {} } };
const EXT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(EXT, p), "utf8");

const { jobCard, jobActions, READY_ACTIONS } = await import("../sidepanel/card.js");
const { entryState, SETUP_LABEL, EDIT_LABEL } = await import("../lib/entry.js");
const { shouldRevealQuick, revealQuick } = await import("../onboarding/quickstart.js");

// ---------- D26: em dashes ----------
// Every file the extension ships except third-party code and the tests. A dash inside a comment is fine
// (nobody sees it), and so is one inside a regex character class, which is matching employers' text
// ([-–—|]), not showing any. Anything else is text a student could read.
function shipped(dir = EXT, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const rel = relative(EXT, p).replace(/\\/g, "/");
    if (/^(vendor|test|icons)(\/|$)/.test(rel) || name === "node_modules") continue;
    if (statSync(p).isDirectory()) shipped(p, out);
    else if (/\.(js|mjs|html|css|json)$/.test(name)) out.push(rel);
  }
  return out;
}
export function emDashesShown(src, kind) {
  const found = [];
  let s = src;
  if (kind === "html") s = s.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  if (kind !== "json") s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  s.split("\n").forEach((line, i) => {
    let code = line;
    if (kind === "js" || kind === "html") {
      const c = code.search(/(^|\s)\/\/(?!\/)/);   // a // comment; "https://" has a ":" before it
      if (c >= 0) code = code.slice(0, c);
    }
    code = code.replace(/\[[^\]\n]*—[^\]\n]*\]/g, "");   // regex character classes
    if (code.includes("—")) found.push(`${i + 1}: ${line.trim().slice(0, 100)}`);
  });
  return found;
}

test("no em dash in any text the extension can show a student", () => {
  const files = shipped();
  assert.ok(files.includes("background/agent.js") && files.includes("popup/popup.html") && files.includes("manifest.json"));
  const bad = [];
  for (const f of files) {
    const kind = f.endsWith(".html") ? "html" : f.endsWith(".json") ? "json" : f.endsWith(".css") ? "css" : "js";
    for (const hit of emDashesShown(read(f), kind)) bad.push(`${f}:${hit}`);
  }
  assert.deepEqual(bad, [], "use a colon, a comma or a full stop instead of an em dash");
});

test("the em dash check catches a string and ignores comments and character classes", () => {
  assert.equal(emDashesShown('const a = "busy right now — try later";', "js").length, 1);
  assert.equal(emDashesShown("const t = `closed — look at the tab`;", "js").length, 1);
  assert.equal(emDashesShown("// a comment — fine\n/* also — fine */\nx.replace(/\\s[-–—|]\\s/g, ' ');", "js").length, 0);
  assert.equal(emDashesShown('const u = "https://x.org"; const b = "a — b";', "js").length, 1);
  assert.equal(emDashesShown("<!-- was — fine --><p>Seen — here</p>", "html").length, 1);
});

// ---------- D25: job card and button order ----------
const job = (status, extra = {}) => ({ id: "j1", status, company: "Northwind Labs", title: "Software Engineering Intern", location: "Boston, MA", log: [], ...extra });

test("Ready to submit: I submitted it (main), Review and submit, Check the form again, then Remove", () => {
  assert.deepEqual(jobActions(job("ready_to_submit")).map(([a, t, c]) => [a, t, c || ""]), [
    ["submitted", "I submitted it", "primary"],
    ["focus", "Review and submit", ""],
    ["resume", "Check the form again", "quiet"],
    ["remove", "Remove", "quiet"],
  ]);
  assert.equal(READY_ACTIONS[0][1], "I submitted it");
  const html = jobCard(job("ready_to_submit"));
  assert.doesNotMatch(html, /Keep going/);
  const order = ["I submitted it", "Review and submit", "Check the form again"].map((t) => html.indexOf(`>${t}</button>`));
  assert.ok(order.every((i) => i > 0) && order[0] < order[1] && order[1] < order[2], String(order));
});

test("a job card is company and title, then the status chip, then one row of small buttons", () => {
  const html = jobCard(job("needs_you", { question: "Why us?", reason: "Not in your profile." }));
  const co = html.indexOf('class="co"'), title = html.indexOf('class="title"'), chip = html.indexOf('class="st"'), row = html.indexOf('class="row"');
  assert.ok(co > 0 && co < title && title < chip && chip < row, [co, title, chip, row].join(","));
  assert.match(html, /<div class="head"><span class="co">Northwind Labs<\/span> <span class="title">Software Engineering Intern · Boston, MA<\/span><\/div>/);
  assert.equal((html.match(/class="row"/g) || []).length, 1);
  const buttons = html.match(/<button [^>]*>/g);
  assert.ok(buttons.length >= 2 && buttons.every((b) => /class="btn small( primary| quiet)?"/.test(b)), buttons.join(" "));
  assert.doesNotMatch(html, /class="b[ "]/, "the side panel's own 26px button.b is gone");
  // Job text is escaped.
  assert.match(jobCard(job("failed", { company: "<b>x</b>", reason: "a & b" })), /&lt;b&gt;x&lt;\/b&gt;[\s\S]*a &amp; b/);
});

test("the in-tab card puts I submitted it first and says Check the form again", () => {
  const src = read("agent/overlay.js");
  const ready = src.slice(src.indexOf('j.status === "ready_to_submit"'), src.indexOf('j.status === "submitted"')).replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(ready, /Keep going/);
  assert.match(ready, /<button class="primary" id="done">I submitted it<\/button><button class="quiet" id="more">Check the form again<\/button>/);
  assert.match(src, /on\("more", \(\) => send\("resume"\)\)/, "Check the form again still starts another pass");
});

test("Deep Dive Next, Google sign-in and Send are primary buttons; .btn.blue is gone", () => {
  const src = read("onboarding/onboarding.js");
  assert.doesNotMatch(src, /btn blue/);
  assert.match(src, /<button class="btn primary" data-go="\$\{next\}">/);
  assert.doesNotMatch(read("lib/theme.css").replace(/\/\*[\s\S]*?\*\//g, ""), /\.btn\.blue/);
  assert.doesNotMatch(read("sidepanel/sidepanel.html").replace(/\/\*[\s\S]*?\*\//g, ""), /button\.b\b/);
});

// ---------- D27 and D29: entry points ----------
const store = (settings = {}, over = {}) => ({ ai: { provider: "internscout" }, files: { resume: { name: "r.pdf" } }, profile: { facts: {} }, settings: { onboarded: false, ...settings }, ...over });

test("before setup: one setup button, no review link and no way to edit a setup never done", () => {
  const e = entryState(store());
  assert.equal(e.stage, "setup");
  assert.equal(e.label, "Set up Auto-Apply (about 2 minutes)");
  assert.equal(SETUP_LABEL, e.label);
  assert.equal(e.showReview, false);
  assert.equal(e.showEdit, false);
  assert.doesNotMatch(e.note, /Deep Dive/);
});

test("after setup: Edit setup and the review link show; a replaced resume asks for its review", () => {
  const ready = entryState(store({ onboarded: true, resume_details_ready: true }));
  assert.deepEqual([ready.stage, ready.label, ready.showReview, ready.showEdit], ["ready", EDIT_LABEL, true, true]);
  const paused = entryState(store({ onboarded: true, resume_details_ready: false }));
  assert.deepEqual([paused.stage, paused.label, paused.showReview], ["paused", "Review my resume", true]);
});

test("popup and side panel follow entryState: review link hidden until set up, no Start Deep Dive", () => {
  const html = read("popup/popup.html"), js = read("popup/popup.js");
  assert.match(html, /<div class="foot" id="foot" hidden>/);
  assert.match(html, /<button class="btn primary" id="setup" hidden>Set up Auto-Apply \(about 2 minutes\)<\/button>/);
  assert.match(js, /\$\("foot"\)\.hidden = !e\.showReview/);
  const panel = read("sidepanel/sidepanel.js");
  assert.match(panel, /if \(e\.showReview\) h \+= `<div class="foot">/);
  assert.match(panel, /e\.showEdit \? `<button class="btn small quiet" id="dive2">/);
  for (const [f, src] of [["popup.html", html], ["popup.js", js], ["sidepanel.js", panel]]) {
    assert.doesNotMatch(src.replace(/\/\/.*|<!--[\s\S]*?-->/g, ""), /Start Deep Dive|Redo Deep Dive|Open Deep Dive/, f);
  }
});

test("the setup page is called Set up Auto-Apply; Deep Dive names the optional Interview and Voice", () => {
  const html = read("onboarding/onboarding.html").replace(/<!--[\s\S]*?-->/g, "");
  assert.match(html, /<h1>Set up Auto-Apply<\/h1>/);
  const src = read("onboarding/onboarding.js");
  assert.match(src, /<h2>Interview<\/h2><p class="lead">The optional Deep Dive, part 1:/);
  assert.match(src, /<h2>Your voice<\/h2><p class="lead">The optional Deep Dive, part 2:/);
});

// ---------- D28: Ready to apply ----------
test("Ready to apply is brought into view only when it turns ready on the page", () => {
  assert.equal(shouldRevealQuick(false, true), true);
  assert.equal(shouldRevealQuick(null, true), false, "arriving on Files with it already ready keeps the heading's focus");
  assert.equal(shouldRevealQuick(true, true), false, "a redraw while ready does not jump again");
  assert.equal(shouldRevealQuick(false, false), false);
  const calls = [];
  const box = { scrollIntoView: (o) => calls.push(["scroll", o]) };
  const button = { focus: (o) => calls.push(["focus", o]) };
  revealQuick(box, button);
  assert.deepEqual(calls, [["scroll", { block: "center", behavior: "smooth" }], ["focus", { preventScroll: true }]]);
  calls.length = 0;
  revealQuick(box, button, true);
  assert.equal(calls[0][1].behavior, "auto", "no smooth scroll when the student asked for less motion");
  revealQuick(null, button);   // no card: nothing happens, nothing throws
});
