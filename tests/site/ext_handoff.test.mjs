// The dashboard's side of two extension fixes (2026-10-14): U2, the postings picked before setup are kept
// and the note says so; U8, the dashboard offers its own sign-in to a signed-out extension.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../../docs/js/app.js", import.meta.url), "utf8");

test("U8: the dashboard offers only its own session code, once, to an installed extension that is signed out", () => {
  const i = app.indexOf('type: "auth:offer"');
  assert.ok(i > 0, "the offer is sent");
  const block = app.slice(app.lastIndexOf("useEffect(", i), app.indexOf("}, [", i));
  assert.match(block, /offeredAuth\.current/, "once per page load");
  assert.match(block, /!info\.installed/);
  assert.match(block, /info\.signed_in !== false/, "only when the extension says it is signed out");
  assert.match(block, /auth\.source !== "page"/, "never a sign-in the extension handed the page");
  assert.match(block, /\^iss_/, "only a session code, never an ID token");
  assert.equal(app.split('type: "auth:offer"').length, 2, "sent from one place only");
});

test("U2: the setup note says the picked postings are kept when the extension kept them", () => {
  assert.match(app, /res\.held === 1 \? "The posting" : `The \$\{res\.held\} postings`\} you picked will be waiting there, ready to start when you finish\./);
});
