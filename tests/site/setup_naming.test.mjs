// D29 (2026-10-14 design review): the site's ways into the extension's setup say "Set up Auto-Apply (about
// 2 minutes)", as the extension's own buttons do. "Deep Dive" sounded long and optional; it now names only
// the optional Interview and Voice steps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const code = (s) => s.replace(/<!--[\s\S]*?-->/g, "").replace(/^\s*\/\/.*$/gm, "");

test("the dashboard's setup button, notice and queue note say Set up Auto-Apply", () => {
  const app = code(read("docs/js/app.js"));
  // Once set up it says "Edit setup", as the extension's popup and side panel do (lib/entry.js).
  assert.match(app, /info\.onboarded \? "Edit setup" : "Set up Auto-Apply \(about 2 minutes\)"/);
  assert.match(app, /"set up Auto-Apply so it knows your background\. ", h\("a", .*"Set up Auto-Apply \(about 2 minutes\)"\)/);
  // was: ... in a new tab\."\)/. Since U2 (2026-10-14) a sentence about the kept postings may follow.
  assert.match(app, /setNote\("Set up Auto-Apply first \(about 2 minutes\)\. It just opened in a new tab\." \+ \(res\.held/);
  assert.doesNotMatch(app, /Start Deep Dive|Start the Deep Dive|do the Deep Dive|Finish the Deep Dive/);
});

test("the install page's steps and HowTo say Set up Auto-Apply, and keep Deep Dive for the optional part", () => {
  const html = code(read("docs/install.html"));
  assert.doesNotMatch(html, /Deep Dive setup|Finish the <strong>Deep Dive<\/strong>|redo the Deep Dive/);
  assert.match(html, /<strong>Set up Auto-Apply<\/strong> opens in a new tab: sign in and add your resume \(about 2 minutes\)\./);
  // was: ...(about 2 minutes\)\."/ at the end of step 1's text. Since U6 it opens step 2's.
  assert.match(html, /"name":"Set up Auto-Apply","text":"Auto-Apply setup opens in a new tab: sign in and add your resume \(about 2 minutes\)\./);
  assert.match(html, /the optional <strong>Deep Dive<\/strong> \(a short interview and your writing voice\)/);
});
