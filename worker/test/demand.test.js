import test from "node:test";
import assert from "node:assert/strict";
import { setup } from "./helpers.js";

const counts = (w, token = "ci-test-token") => w.api("GET", "/demand", { token });

test("GET /demand needs DEMAND_TOKEN", async () => {
  const w = await setup();
  assert.equal((await w.api("GET", "/demand")).status, 401);
  assert.equal((await counts(w, "wrong")).status, 401);
  assert.equal((await counts(w, await w.token())).status, 401, "a student token is not the CI token");
  assert.equal((await counts(w)).status, 200);

  const unset = await setup({ env: { DEMAND_TOKEN: "" } });
  assert.equal((await unset.api("GET", "/demand", { headers: { Authorization: "Bearer " } })).status, 401);
});

test("POST /demand replaces the user's row; GET counts states", async () => {
  const w = await setup();
  const a = await w.token();
  const b = await w.token({ sub: "second" });
  assert.equal((await w.api("POST", "/demand", { body: { states: ["MA"] } })).status, 401);
  assert.equal((await w.api("POST", "/demand", { token: a, body: { states: ["MA", "NY"] } })).status, 200);
  await w.api("POST", "/demand", { token: b, body: { states: ["ma", "remote", "MA"] } });
  assert.deepEqual(await (await counts(w)).json(),
    { states: { MA: 2, NY: 1, REMOTE: 1 }, users: 2, updated: "2026-09-14T10:05:30Z" });

  await w.api("POST", "/demand", { token: a, body: { states: ["CA"] } });
  assert.deepEqual((await (await counts(w)).json()).states, { MA: 1, REMOTE: 1, CA: 1 });
});

test("bad state lists -> 400", async () => {
  const w = await setup();
  const token = await w.token();
  const status = async (body) => (await w.api("POST", "/demand", { token, body })).status;
  assert.equal(await status({ states: ["MA", "XX"] }), 400);
  assert.equal(await status({ states: "MA" }), 400);
  assert.equal(await status({ states: Array(61).fill("MA") }), 400);
});

test("only users active in the last 90 days count", async () => {
  const w = await setup();
  const token = await w.token();
  await w.api("POST", "/demand", { token, body: { states: ["TX"] } });
  w.setNow(new Date("2026-12-14T10:05:30Z"));   // 91 days later
  assert.equal((await (await counts(w)).json()).users, 0);
  // any signed-in visit marks the user active again
  await w.api("GET", "/me", { token: await w.token() });
  assert.deepEqual((await (await counts(w)).json()).states, { TX: 1 });
});
