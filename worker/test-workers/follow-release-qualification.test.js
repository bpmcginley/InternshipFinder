// Offline vertical rehearsal. All release, archive, sender and capacity values are synthetic.
import assert from "node:assert/strict";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, it, vi } from "vitest";
import worker, { handle } from "../src/index.js";
import { createFollowLinkPresentation } from "../src/follow-link-presentation.js";
import { createOwnedFollowLinkRuntime } from "../src/follow-owned-runtime.js";
import { createOwnedFollowDigestRuntime } from "../src/follow-owned-digest-runtime.js";
import { enqueueFollowArchiveSubscriber } from "../src/follow-archive-enqueue.js";
import { createFollowArchiveReader } from "../src/follow-archive-reader.js";
import { followSnapshotDigest } from "../src/follow-matching.js";

const site = "https://internscout.org",
  emailAddress = "rehearsal@example.test";
const catalogUrl = "https://catalog.example.test/catalog.json";
const indexUrl = "https://archive.example.test/data/follows/index.json";
const encode = (v) => new TextEncoder().encode(JSON.stringify(v));
const iso = (v) => new Date(v).toISOString();
const count = (table) => env.DB.prepare(`SELECT count(*) AS n FROM ${table}`).first("n");
const owner = () => env.DB.prepare("SELECT * FROM follow_delivery_owner").first();
const databaseTime = () =>
  env.DB.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at").first("at");
const catalog = {
  companies: new Set(["fixture"]),
  fields: new Set(["swe"]),
  states: new Set(["MA"]),
};
const limits = {
  maxBytes: 8000,
  maxRoles: 10,
  maxFollows: 10,
  maxMatches: 10,
  maxResultBytes: 8000,
  maxTextBytes: 2000,
  maxWindowMs: 86400000,
};
const presentation = {
  from: "sender@example.test",
  postalAddress: "Synthetic test address",
  origins: [site],
};
const linkPolicy = {
  sending: true,
  cap: 10,
  confirmation: {
    present: ({ confirmation, deleteRequest, unsubscribe }) => ({
      ...presentation,
      summary: "Fixture",
      links: {
        confirmation: `${site}/follows/action.html#purpose=confirm&token=${confirmation}`,
        deleteRequest: `${site}/follows/action.html#purpose=delete-request&token=${deleteRequest}`,
        unsubscribe: `${site}/unsubscribe?token=${unsubscribe}`,
      },
    }),
  },
  management: {
    presentation,
    buildLinks: ({ management, unsubscribe }) => ({
      management: `${site}/follows/manage.html#token=${management}`,
      unsubscribe: `${site}/unsubscribe?token=${unsubscribe}`,
    }),
  },
};
const settings = {
  FOLLOW_SIGNUP_ENABLED: "1",
  FOLLOW_MANAGEMENT_ENABLED: "1",
  FOLLOW_MANAGEMENT_REQUEST_ENABLED: "1",
  FOLLOW_MANAGEMENT_REQUEST_TTL_MS: "60000",
  FOLLOW_MANAGEMENT_REQUEST_DAILY_CAP: "10",
};
function post(path, value, plain = false) {
  return new Request(`https://api.example.test${path}`, {
    method: "POST",
    headers: { Origin: site, "Content-Type": plain ? "text/plain" : "application/json" },
    body: plain ? value : JSON.stringify(value),
  });
}
const signupBody = {
  email: emailAddress,
  link: false,
  scope: { kind: "company", company: "fixture" },
};
const tokenFrom = (message, prefix) => {
  const line = message.text.split("\n").find((v) => v.startsWith(prefix));
  assert.ok(line, "expected capability in synthetic rendered mail");
  return new URLSearchParams(new URL(line.slice(prefix.length)).hash.slice(1)).get("token");
};

afterEach(() => vi.unstubAllGlobals());

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch(
    ["follow_subscribers", "follow_send_budget", "follow_digest_days", "rate"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
  // Initial synthetic installation only; never used to reset a held owner in a scenario.
  await env.DB.prepare(
    "INSERT OR REPLACE INTO follow_delivery_owner(singleton,version,generation,phase,next_kind) VALUES(1,1,lower(hex(randomblob(16))),'ready','confirmation')",
  ).run();
}, 15000);

async function fixture(ttl = 60000) {
  const at = Date.now(),
    source = "a".repeat(64);
  const bytes = encode({
    version: 1,
    source_sha256: source,
    signup: { companies: ["fixture"], fields: ["swe"], states: ["MA"] },
    valid: { companies: ["fixture"], fields: ["swe"], states: ["MA"] },
    aliases: [["Fixture", "fixture"]],
  });
  const release = {
    url: catalogUrl,
    sourceSha256: source,
    catalogSha256: await followSnapshotDigest(bytes),
    notBefore: at - 1000,
    expiresAt: at + ttl,
  };
  const policy = {
    origin: new URL(catalogUrl).origin,
    release,
    previousValid: catalog,
    maxBytes: bytes.length,
    maxKeys: 10,
    deadlineMs: 5000,
    dailyLimit: 10,
  };
  const sent = [],
    fetches = [];
  const binding = {
    send: async (message) => {
      sent.push(message);
      return { messageId: "synthetic" };
    },
  };
  const deps = {
    now: () => new Date(),
    followSignupRelease: () => policy,
    fetch: async (url, options) => {
      assert.equal(url, catalogUrl);
      assert.equal(options.method, "GET");
      fetches.push(url);
      const r = new Response(bytes);
      Object.defineProperty(r, "url", { value: catalogUrl });
      return r;
    },
  };
  const http = (path, value, plain = false, db = env.DB) =>
    handle(post(path, value, plain), { ...settings, DB: db }, undefined, deps);
  const link = (email = binding) =>
    createOwnedFollowLinkRuntime({
      enabled: true,
      db: env.DB,
      email,
      policy: () => linkPolicy,
      transportTimeoutMs: 1000,
    });
  return { bytes, release, deps, sent, fetches, binding, http, link };
}

async function confirmed(f) {
  const response = await f.http("/follows/signup", signupBody);
  assert.equal(response.status, 202);
  assert.equal(await response.text(), "");
  const original = await env.DB.prepare(
    "SELECT id,expires_at FROM follow_confirmation_outbox",
  ).first();
  assert.equal((await f.http("/follows/signup", signupBody)).status, 202);
  assert.deepEqual(
    await env.DB.prepare("SELECT id,expires_at FROM follow_confirmation_outbox").first(),
    original,
  );
  assert.equal(await count("follow_subscribers"), 1);
  assert.equal(await count("follow_confirmation_outbox"), 1);
  const result = await f.link()({ maxCandidates: 1, maxExpired: 2 });
  assert.equal(result.status, "processed", JSON.stringify(result));
  assert.equal(result.dispatch.counts.accepted, 1);
  assert.equal(f.sent.length, 1);
  const raw = tokenFrom(f.sent[0], "Confirm: ");
  assert.equal((await f.http("/follows/confirm", raw, true)).status, 204);
  assert.equal((await f.http("/follows/confirm", raw, true)).status, 410);
  const sub = await env.DB.prepare(
    "SELECT subscriber_id,scope_key,confirmed_at FROM follow_subscriptions",
  ).first();
  assert.ok(sub.confirmed_at);
  assert.equal((await owner()).phase, "ready");
  return sub;
}

async function archiveFor(f, sub, options = {}) {
  const selectedIndex = options.indexUrl ?? indexUrl;
  // Wait only for the native DB clock to become strictly later than actual confirmation.
  let at;
  const until = Date.now() + 2000;
  do {
    at = await databaseTime();
  } while (at <= sub.confirmed_at && Date.now() < until);
  assert.ok(at > sub.confirmed_at);
  const snapshot = encode({
    version: 1,
    complete: true,
    generated_at: at,
    covers_after: sub.confirmed_at,
    roles: [
      {
        id: "a".repeat(16),
        company_key: "fixture",
        field_tags: ["swe"],
        states: ["MA"],
        first_seen: at,
        status: "open",
        company_name: "Fixture",
        title: "Synthetic role",
        location: "Boston, MA",
        apply_url: "https://jobs.example.test/role",
      },
    ],
  });
  const digest = await followSnapshotDigest(snapshot),
    deadline = iso(Date.parse(at) + 60000);
  const manifest = encode({
    checked_at: at,
    entries: [
      {
        bytes: snapshot.length,
        enqueue_until: deadline,
        generated_at: at,
        retain_until: iso(Date.parse(deadline) + 48 * 3600000 + 1000),
        sha256: digest,
      },
    ],
    high_water: at,
    latest: digest,
    version: 1,
  });
  const requests = [];
  const archive = {
    indexUrl: selectedIndex,
    clock: () => new Date(),
    fetch: async (url, options) => {
      assert.equal(options.method, "GET");
      requests.push(url);
      if (url === selectedIndex) return new Response(manifest);
      assert.equal(url, new URL(digest + ".json", selectedIndex).href);
      return new Response(snapshot);
    },
    bounds: {
      maxManifestBytes: 3000,
      maxEntries: 2,
      maxArchiveBytes: 20000,
      maxEnqueueAgeMs: 60000,
      publishMarginMs: 1000,
      deadlineMs: 5000,
    },
  };
  let receipt;
  if (!options.deferEnqueue) {
    receipt = await enqueueFollowArchiveSubscriber(env.DB, sub.subscriber_id, {
      archive,
      catalog,
      limits,
      maxProgressBytes: 4000,
      maxPendingBytes: 4000,
    });
    assert.equal(receipt.status, "queued");
    assert.equal(requests.length, 2);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(7),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const present = async ({ subscriberId, roles }) => {
    assert.equal(subscriberId, sub.subscriber_id);
    assert.equal(roles.length, 1);
    return {
      ...presentation,
      links: {
        management: `${site}/follows/manage.html#token=${tokenFrom(f.sent.at(-1), "Manage your follows: ")}`,
        unsubscribe: f.sent.at(-1).headers["List-Unsubscribe"].slice(1, -1),
        matchingPage: `${site}/?field=swe`,
        publicShare: `${site}/?field=swe`,
      },
    };
  };
  const reader = createFollowArchiveReader({ ...archive, catalog, limits });
  const runtime = (email = f.binding) =>
    createOwnedFollowDigestRuntime({
      enabled: true,
      db: env.DB,
      email,
      key,
      catalog,
      limits,
      loadSnapshot: reader.loadSnapshot,
      clock: () => new Date(at),
      policy: () => ({
        sending: true,
        cap: 10,
        present: options.present ?? present,
        ...(options.buildLinks ? { buildLinks: options.buildLinks } : {}),
      }),
    });
  return { runtime, receipt, at, archive, manifest, snapshot, digest };
}

async function management(f) {
  assert.equal((await f.http("/follows/manage/request", { email: emailAddress })).status, 202);
  const original = await env.DB.prepare(
    "SELECT id,expires_at FROM follow_management_outbox",
  ).first();
  assert.equal((await f.http("/follows/manage/request", { email: emailAddress })).status, 202);
  assert.deepEqual(
    await env.DB.prepare("SELECT id,expires_at FROM follow_management_outbox").first(),
    original,
  );
  assert.equal((await f.link()({ maxCandidates: 1, maxExpired: 2 })).dispatch.counts.accepted, 1);
  return tokenFrom(f.sent.at(-1), "Manage your follows: ");
}

it("real HTTP signup, owned links, archive digest and management removal conserve one scope", async () => {
  const f = await fixture(),
    sub = await confirmed(f),
    token = await management(f);
  const a = await archiveFor(f, sub);
  const result = await a.runtime()();
  assert.deepEqual(result, { status: "processed", counts: { accepted: 1 } });
  assert.equal(f.sent.length, 3);
  assert.deepEqual(
    f.sent.map((m) => m.subject),
    [
      "Confirm your InternScout follows",
      "Manage your InternScout follows",
      "New internships for your follows",
    ],
  );
  for (const m of f.sent) {
    assert.equal(m.to, emailAddress);
    assert.equal(m.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  }
  assert.match(f.sent[2].text, /Synthetic role/);
  assert.equal(
    await env.DB.prepare("SELECT attempts FROM follow_send_budget").first("attempts"),
    3,
  );
  assert.equal(
    await env.DB.prepare("SELECT watermark FROM follow_scope_progress").first("watermark"),
    a.at,
  );
  assert.equal(await count("follow_pending_progress"), 0);
  assert.equal((await owner()).phase, "ready");
  assert.deepEqual(await a.runtime()(), { status: "processed", counts: {} });
  const list = await f.http("/follows/manage/list", [token, null]);
  assert.equal(list.status, 200);
  const page = await list.json();
  assert.equal(page.scopes.length, 1);
  assert.equal(page.scopes[0].scope_key, sub.scope_key);
  assert.equal(page.next, null);
  assert.deepEqual(await (await f.http("/follows/manage/remove", [token, sub.scope_key])).json(), {
    removed: true,
  });
  assert.equal(await count("follow_subscriptions"), 0);
  assert.equal(await count("follow_scope_progress"), 0);
  assert.equal(f.sent.length, 3);
}, 15000);

it("real entry stays closed or rejects malformed input before catalog or storage", async () => {
  const f = await fixture();
  let io = 0;
  const unexpected = () => {
    io++;
    throw Error("synthetic unexpected I/O");
  };
  const db = { prepare: unexpected, batch: unexpected };
  const deps = { ...f.deps, fetch: unexpected };
  const run = (request, enabled) => handle(request, { DB: db, ...enabled }, undefined, deps);
  assert.equal((await run(post("/follows/signup", signupBody), {})).status, 404);
  assert.equal(
    (await run(post("/follows/signup", { ...signupBody, email: "invalid" }), settings)).status,
    400,
  );
  const badOrigin = post("/follows/signup", signupBody);
  badOrigin.headers.set("Origin", "https://other.example.test");
  assert.equal((await run(badOrigin, settings)).status, 403);
  assert.equal(io, 0);
  assert.equal(await count("follow_subscribers"), 0);
}, 15000);

it("uncertain confirmation holds the persisted owner across fresh link and digest instances", async () => {
  const f = await fixture();
  assert.equal((await f.http("/follows/signup", signupBody)).status, 202);
  let calls = 0;
  const uncertain = {
    send: async () => {
      calls++;
      throw Error("synthetic lost acknowledgement");
    },
  };
  const result = await f.link(uncertain)({ maxCandidates: 1, maxExpired: 2 });
  assert.equal(result.status, "held");
  const held = await owner();
  assert.equal(held.phase, "held");
  assert.equal(
    await env.DB.prepare("SELECT attempts FROM follow_send_budget").first("attempts"),
    1,
  );
  assert.equal((await f.link(uncertain)({ maxCandidates: 1, maxExpired: 2 })).status, "held");
  const digest = createOwnedFollowDigestRuntime({
    enabled: true,
    db: env.DB,
    email: uncertain,
    policy: () => ({ sending: true, cap: 10, present: async () => presentation }),
    loadSnapshot: async () => {
      throw Error("must not load");
    },
  });
  assert.equal((await digest()).status, "held");
  assert.deepEqual(await owner(), held);
  assert.equal(calls, 1);
}, 15000);

it("SQLite cutoff rejects a signup admitted by a lagging Worker after the catalog expires", async () => {
  const f = await fixture();
  // A deliberately lagging Worker sees a valid immutable release; actual SQLite is already
  // past it. This qualifies the SQL boundary without a load-sensitive subsecond timer.
  const cutoff = Date.parse(await databaseTime()) - 1000;
  f.release.notBefore = cutoff - 60000;
  f.release.expiresAt = cutoff;
  f.deps.now = () => new Date(cutoff - 1);
  let guarded = 0;
  const sqlOf = new WeakMap();
  const wrap = (s, sql) => {
    const result = {
      bind: (...args) => wrap(s.bind(...args), sql),
      run: () => s.run(),
      all: () => s.all(),
      first: (...args) => s.first(...args),
      raw: s,
    };
    sqlOf.set(result, sql);
    return result;
  };
  const db = {
    prepare: (sql) => wrap(env.DB.prepare(sql), sql),
    batch: async (statements) => {
      assert.ok(sqlOf.get(statements[0]).includes("follow_catalog_admissions"));
      guarded++;
      assert.ok(Date.parse(await databaseTime()) >= f.release.expiresAt);
      return env.DB.batch(statements.map((s) => s.raw));
    },
  };
  assert.equal((await f.http("/follows/signup", signupBody, false, db)).status, 503);
  assert.equal(guarded, 1);
  assert.equal(await count("follow_subscribers"), 0);
  assert.equal(await count("follow_confirmation_outbox"), 0);
  assert.equal(await count("rate"), 1);
  assert.equal(await env.DB.prepare("SELECT calls FROM rate").first("calls"), 1);
  assert.equal(f.sent.length, 0);
}, 15000);

it("default HTTP and scheduled deployments complete one pinned signup-to-unsubscribe lifecycle", async () => {
  const f = await fixture(),
    currentUrl = `${site}/data/follows/current.json`,
    labelsUrl = `${site}/data/follow-labels.json`,
    archiveUrl = `${site}/data/follows/index.json`,
    linksCron = "11 3 * * *",
    archiveCron = "21 3 * * *";
  const handoffs = [],
    send = f.binding.send;
  f.binding.send = async (message) => {
    handoffs.push({
      owner: await owner(),
      attempts: await env.DB.prepare("SELECT attempts FROM follow_send_budget").first("attempts"),
    });
    return send(message);
  };
  const release = { ...f.release, url: currentUrl };
  const catalogDescriptor = {
    version: 1,
    origin: site,
    predecessor: { genesis: true },
    release,
    maxBytes: 4000,
    maxKeys: 10,
    deadlineMs: 10000,
  };
  const labels = encode({
    version: 1,
    source_sha256: release.sourceSha256,
    catalog_sha256: release.catalogSha256,
    companies: [["fixture", "Fixture"]],
    fields: [["swe", "Software Engineering"]],
    states: [["MA", "Massachusetts"]],
  });
  const files = new Map([
      [currentUrl, f.bytes],
      [labelsUrl, labels],
    ]),
    requests = [];
  vi.stubGlobal("fetch", async (url, init) => {
    assert.equal(init.method, "GET");
    assert.equal(new URL(url).origin, site);
    assert.ok(files.has(url), "unexpected synthetic URL; never forward to network");
    requests.push(url);
    return Object.defineProperty(new Response(files.get(url)), "url", { value: url });
  });
  const bindings = {
    ...settings,
    DB: env.DB,
    EMAIL: f.binding,
    FOLLOW_SIGNUP_RELEASE: JSON.stringify({ ...catalogDescriptor, dailyLimit: 10 }),
    FOLLOW_LINKS_ENABLED: "1",
    FOLLOW_LINKS_CRON: linksCron,
    FOLLOW_LINKS_RELEASE: JSON.stringify({
      version: 1,
      origin: site,
      predecessor: catalogDescriptor.predecessor,
      deadlineMs: 10000,
      policy: {
        from: presentation.from,
        postalAddress: presentation.postalAddress,
        cap: 10,
        maxCandidates: 1,
        maxExpired: 2,
        transportTimeoutMs: 1000,
      },
      release: {
        catalogUrl: currentUrl,
        labelsUrl,
        sourceSha256: release.sourceSha256,
        catalogSha256: release.catalogSha256,
        labelsSha256: await followSnapshotDigest(labels),
        notBefore: release.notBefore,
        expiresAt: release.expiresAt,
        maxCatalogBytes: 4000,
        maxLabelBytes: 4000,
        maxKeys: 10,
      },
    }),
    FOLLOW_ARCHIVE_ENABLED: "1",
    FOLLOW_ARCHIVE_CRON: archiveCron,
  };
  const scheduled = async (cron, selected = bindings) => {
    const pending = [];
    worker.scheduled({ cron }, selected, { waitUntil: (job) => pending.push(job) });
    assert.equal(pending.length, 1);
    return (await Promise.all(pending))[0];
  };
  const http = (path, body, plain = false) => worker.fetch(post(path, body, plain), bindings);
  assert.equal(
    (
      await worker.fetch(post("/follows/signup", signupBody), {
        ...bindings,
        FOLLOW_SIGNUP_ENABLED: "0",
      })
    ).status,
    404,
  );
  assert.equal(requests.length, 0);
  assert.equal((await http("/follows/signup", signupBody)).status, 202);
  assert.deepEqual(requests, [currentUrl]);
  assert.equal(await count("follow_confirmation_outbox"), 1);
  assert.equal(f.sent.length, 0);
  assert.deepEqual(await scheduled(linksCron), { status: "processed" });
  assert.deepEqual(requests, [currentUrl, currentUrl, labelsUrl]);
  assert.equal(f.sent.length, 1);
  assert.equal(
    (await http("/follows/confirm", tokenFrom(f.sent[0], "Confirm: "), true)).status,
    204,
  );
  const sub = await env.DB.prepare(
    "SELECT subscriber_id,scope_key,confirmed_at FROM follow_subscriptions",
  ).first();
  assert.ok(sub.confirmed_at);
  const privatePresentation = createFollowLinkPresentation({
    ...presentation,
    labels: { companies: new Map([["fixture", "Fixture"]]), fields: new Map(), states: new Map() },
  }).management;
  const a = await archiveFor(f, sub, {
    deferEnqueue: true,
    indexUrl: archiveUrl,
    buildLinks: privatePresentation.buildLinks,
    present: async () => ({
      ...privatePresentation.presentation,
      links: { matchingPage: `${site}/?field=swe`, publicShare: `${site}/?field=swe` },
    }),
  });
  files.set(archiveUrl, a.manifest);
  files.set(new URL(a.digest + ".json", archiveUrl).href, a.snapshot);
  bindings.FOLLOW_ARCHIVE_RELEASE = JSON.stringify({
    version: 1,
    catalog: catalogDescriptor,
    archive: {
      indexUrl: archiveUrl,
      indexSha256: await followSnapshotDigest(a.manifest),
      bounds: a.archive.bounds,
    },
    limits,
    budget: {
      maxPages: 2,
      pageSize: 1,
      maxSubscribers: 2,
      maxD1Calls: 48,
      maxStatements: 100,
      maxFetches: 6,
      deadlineMs: 10000,
    },
    maxProgressBytes: 4000,
    maxPendingBytes: 4000,
  });
  const priorOwner = await owner();
  const queued = await scheduled(archiveCron);
  assert.equal(queued.status, "pass-complete", JSON.stringify(queued));
  assert.equal(queued.counts.queued, 1);
  assert.deepEqual(requests.slice(3), [
    currentUrl,
    archiveUrl,
    new URL(a.digest + ".json", archiveUrl).href,
  ]);
  assert.deepEqual(await owner(), priorOwner);
  assert.equal(f.sent.length, 1);
  assert.equal(await count("follow_digest_outbox"), 1);
  assert.equal(await count("follow_pending_progress"), 1);
  assert.deepEqual(await a.runtime()(), { status: "processed", counts: { accepted: 1 } });
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1].text, /Synthetic role/);
  assert.equal(
    await env.DB.prepare("SELECT attempts FROM follow_send_budget").first("attempts"),
    2,
  );
  assert.equal(
    await env.DB.prepare("SELECT watermark FROM follow_scope_progress").first("watermark"),
    a.at,
  );
  assert.equal(await count("follow_pending_progress"), 0);
  assert.equal((await owner()).phase, "ready");
  assert.deepEqual(await a.runtime()(), { status: "processed", counts: {} });
  assert.equal(f.sent.length, 2);
  const manage = tokenFrom(f.sent[1], "Manage my follows: ");
  assert.equal((await http("/follows/manage/list", [manage, null])).status, 200);
  assert.deepEqual(
    handoffs.map(({ owner: row, attempts }) => [row.singleton, row.phase, attempts]),
    [
      [1, "running", 1],
      [1, "running", 2],
    ],
  );
  assert.equal(f.sent.filter((m) => m.subject === "New internships for your follows").length, 1);
  const unsubscribe = f.sent[1].headers["List-Unsubscribe"].slice(1, -1);
  assert.notEqual(unsubscribe, f.sent[0].headers["List-Unsubscribe"].slice(1, -1));
  assert.equal(new URL(unsubscribe).pathname, "/follows/unsubscribe");
  assert.equal(f.sent[1].headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  const closed = {
    ...bindings,
    FOLLOW_SIGNUP_ENABLED: "0",
    FOLLOW_LINKS_ENABLED: "0",
    FOLLOW_ARCHIVE_ENABLED: "0",
    FOLLOW_MANAGEMENT_REQUEST_ENABLED: "0",
  };
  const remove = () =>
    worker.fetch(
      new Request(unsubscribe, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
        credentials: "omit",
        redirect: "manual",
      }),
      closed,
    );
  assert.equal((await remove()).status, 204);
  assert.equal((await remove()).status, 204);
  for (const table of [
    "follow_subscribers",
    "follow_subscriptions",
    "follow_tokens",
    "follow_digest_outbox",
    "follow_pending_progress",
    "follow_scope_progress",
  ])
    assert.equal(await count(table), 0);
  assert.equal((await owner()).phase, "ready");
  assert.equal(await count("follow_digest_days"), 1);
  assert.equal(
    await env.DB.prepare("SELECT attempts FROM follow_send_budget").first("attempts"),
    2,
  );
  assert.equal(f.sent.length, 2);
}, 15000);
