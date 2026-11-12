import assert from "node:assert/strict";
import { handle } from "../src/index.js";
import { createSession, sessionTokenHash } from "../src/session.js";

const site = "https://internscout.org";
const catalogOrigin = "https://catalog.example.test";
const url = `${catalogOrigin}/synthetic.json`;
const enabled = { FOLLOW_SIGNUP_ENABLED: "1" };
const shape = (extra = {}) => ({
  email: "reader@example.test",
  link: false,
  scope: { kind: "company", company: "fixture" },
  ...extra,
});
const post = (input = shape(), headers = {}, suffix = "") =>
  new Request("https://api.example.test/follows/signup" + suffix, {
    method: "POST",
    body: JSON.stringify(input),
    headers: { Origin: site, "Content-Type": "application/json", ...headers },
  });
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n");
async function fixture() {
  const now = Date.now(),
    source = "a".repeat(64);
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      source_sha256: source,
      signup: { companies: ["fixture"], fields: ["biology"], states: ["MA"] },
      valid: { companies: ["fixture", "retired"], fields: ["biology"], states: ["MA"] },
      aliases: [["Fixture", "fixture"]],
    }),
  );
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  const release = {
    url,
    sourceSha256: source,
    catalogSha256: digest,
    notBefore: now - 1000,
    expiresAt: now + 60000,
  };
  const policy = {
    origin: catalogOrigin,
    release,
    maxBytes: bytes.length,
    maxKeys: 10,
    deadlineMs: 1000,
    dailyLimit: 10,
    previousValid: {
      companies: new Set(["retired"]),
      fields: new Set(["biology"]),
      states: new Set(["MA"]),
    },
  };
  const reply = () => {
    const response = new Response(bytes);
    Object.defineProperty(response, "url", { value: url });
    return response;
  };
  return { now, release, policy, reply };
}

export async function defaultAndUnqualifiedReleasePreserveTheExisting404() {
  const { now, release, policy } = await fixture();
  let reads = 0,
    calls = 0;
  const unexpected = () => {
    reads++;
    throw Error("Synthetic unexpected I/O");
  };
  const db = { prepare: unexpected, batch: unexpected };
  const supply = () => {
    calls++;
    return policy;
  };
  const run = (request, settings, followSignupRelease) =>
    handle(request, { ...settings, DB: db }, undefined, {
      fetch: unexpected,
      now: () => new Date(now),
      followSignupRelease,
    });
  for (const [settings, followSignupRelease] of [
    [{}, supply],
    [{ FOLLOW_SIGNUP_ENABLED: 1 }, supply],
    [enabled, undefined],
    [enabled, () => ({ ...policy, previousValid: undefined })],
    [enabled, () => ({ ...policy, dailyLimit: 0 })],
    [enabled, () => ({ ...policy, release: { ...release, catalogSha256: "invalid" } })],
    [enabled, () => ({ ...policy, release: { ...release, url: url + "?" } })],
    [enabled, () => ({ ...policy, release: { ...release, expiresAt: now } })],
    [enabled, () => ({ ...policy, release: { ...release, notBefore: now + 1 } })],
    [
      enabled,
      async () => {
        throw Error("Synthetic invalid supplier");
      },
    ],
  ]) {
    const request = post();
    const result = await run(request, settings, followSignupRelease);
    assert.equal(result.status, 404);
    assert.deepEqual(await result.json(), { error: "not_found", message: "No such endpoint" });
    assert.equal(request.bodyUsed, false);
  }
  assert.equal(calls, 0);
  const delayed = post();
  let time = now;
  const result = await handle(delayed, { ...enabled, DB: db }, undefined, {
    now: () => new Date(time),
    fetch: unexpected,
    followSignupRelease: () => {
      time = release.expiresAt;
      return policy;
    },
  });
  assert.equal(result.status, 404);
  assert.equal(delayed.bodyUsed, false);
  for (const [header, settings] of [
    ["https://bpmcginley.github.io", enabled],
    [site, { ...enabled, ALLOWED_ORIGINS: "https://other.example.test" }],
  ]) {
    const request = post(shape(), { Origin: header });
    const result = await run(request, settings, supply);
    assert.equal(result.status, 403);
    assert.equal(request.bodyUsed, false);
  }
  for (const suffix of ["?", "#synthetic", "?#synthetic", "?value=synthetic"]) {
    const request = post(shape(), {}, suffix);
    assert.equal((await run(request, enabled, supply)).status, 400);
    assert.equal(request.bodyUsed, false);
  }
  assert.equal(reads, 0);
}

export async function verifiedCatalogAndExistingSessionAreTheOnlyAdmissionAuthority(db) {
  const { now, release, policy, reply } = await fixture();
  let reads = 0,
    current = now;
  const run = (input, headers = {}, trusted = policy, onFetch = () => {}) =>
    handle(post(input, headers), { ...enabled, DB: db }, undefined, {
      now: () => new Date(current),
      followSignupRelease: (...args) => {
        assert.equal(args.length, 0);
        return trusted;
      },
      fetch: async (target, init) => {
        reads++;
        assert.equal(target, url);
        assert.equal(init.method, "GET");
        assert.equal(init.redirect, "manual");
        assert.equal(init.credentials, "omit");
        assert.equal(init.cache, "no-store");
        onFetch();
        return reply();
      },
    });
  assert.equal((await run(shape({ link: true }))).status, 503);
  assert.equal(reads, 0);
  assert.equal(
    (await run(shape(), {}, { ...policy, release: { ...release, catalogSha256: "b".repeat(64) } }))
      .status,
    503,
  );
  assert.equal((await run(shape({ scope: { kind: "company", company: "retired" } }))).status, 400);
  assert.equal(await count(db, "rate"), 0);
  assert.equal(await count(db, "follow_confirmation_outbox"), 0);
  const anonymous = await run(shape(), { Authorization: "Bearer ignored" });
  assert.equal(anonymous.status, 202);
  assert.equal(anonymous.headers.get("Access-Control-Allow-Origin"), site);
  assert.equal(await anonymous.text(), "");
  const user = "c".repeat(64);
  const { token } = await createSession(
    db,
    { user, tier: "general", provider: "google" },
    new Date(now),
  );
  const id = await sessionTokenHash(token);
  await db
    .prepare("UPDATE sessions SET last_used=? WHERE id=?")
    .bind("2020-01-01T00:00:00.000Z", id)
    .run();
  const session = () => db.prepare("SELECT * FROM sessions WHERE id=?").bind(id).first();
  const before = await session();
  assert.equal(
    (
      await run(shape({ email: "linked@example.test", link: true }), {
        Authorization: `Bearer ${token}`,
      })
    ).status,
    202,
  );
  assert.deepEqual(await session(), before);
  const linked = shape({ email: "late@example.test", link: true });
  const body = new ReadableStream({
    pull(controller) {
      current = release.expiresAt;
      controller.enqueue(new TextEncoder().encode(JSON.stringify(linked)));
      controller.close();
    },
  });
  const delayed = new Request(post(linked, { Authorization: `Bearer ${token}` }), {
    body,
    duplex: "half",
  });
  let lateReads = 0;
  const unexpected = () => {
    lateReads++;
    throw new Error("Synthetic unexpected I/O");
  };
  const late = await handle(delayed, { ...enabled, DB: { prepare: unexpected } }, undefined, {
    now: () => new Date(current),
    followSignupRelease: () => policy,
    fetch: unexpected,
  });
  assert.equal(late.status, 503);
  assert.equal(lateReads, 0);
  current = now;
  assert.equal(
    await db
      .prepare(
        "SELECT owner_user_hash FROM follow_confirmation_outbox WHERE owner_user_hash IS NOT NULL",
      )
      .first("owner_user_hash"),
    user,
  );
  assert.equal(
    (
      await run(shape({ email: "late@example.test" }), {}, policy, () => {
        current = release.expiresAt;
      })
    ).status,
    503,
  );
  assert.equal(await count(db, "follow_confirmation_outbox"), 2);
  assert.equal(await db.prepare("SELECT calls FROM rate").first("calls"), 2);
  assert.equal(reads, 5);
}

export async function oneIsolateLimitSpansRequestOwnedCatalogLoads(db) {
  const { now, policy, reply } = await fixture();
  let reached,
    release,
    loads = 0;
  const ready = new Promise((resolve) => (reached = resolve));
  const pending = new Promise((resolve) => (release = resolve));
  const run = (request) =>
    handle(request, { ...enabled, DB: db }, undefined, {
      now: () => new Date(now),
      followSignupRelease: () => policy,
      fetch: async () => {
        if (++loads === 4) reached();
        await pending;
        return reply();
      },
    });
  const jobs = Array.from({ length: 4 }, (_, n) =>
    run(post(shape({ email: `reader${n}@example.test` }))),
  );
  try {
    await Promise.race([ready, Promise.race(jobs).then(() => assert.fail("Early response"))]);
    const fifth = post();
    assert.equal((await run(fifth)).status, 503);
    assert.equal(fifth.bodyUsed, false);
    assert.equal(loads, 4);
  } finally {
    release();
    assert.deepEqual(
      (await Promise.all(jobs)).map((result) => result.status),
      [202, 202, 202, 202],
    );
  }
  assert.equal((await run(post())).status, 202);
  assert.equal(loads, 5);
}
