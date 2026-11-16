import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { runFollowScheduledLinks } from "../src/follow-scheduled-links.js";
import { requestFollowConfirmation } from "../src/follows.js";

const cron = "11 3 * * *",
  origin = "https://internscout.org";
const keys = { companies: ["fixture", "retained"], fields: ["software"], states: ["NY"] };
const pack = (v) => new TextEncoder().encode(JSON.stringify(v));
const sha = async (b) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
const reply = (url, body, init) =>
  Object.defineProperty(new Response(body, init), "url", { value: url });
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const sourceSha256 = "a".repeat(64),
    catalog = pack({
      version: 1,
      source_sha256: sourceSha256,
      signup: { ...keys, companies: ["fixture"] },
      valid: keys,
      aliases: [["Fixture Labs", "fixture"]],
    });
  const catalogSha256 = await sha(catalog);
  const labels = pack({
    version: 1,
    source_sha256: sourceSha256,
    catalog_sha256: catalogSha256,
    companies: [
      ["fixture", "Fixture Labs"],
      ["retained", "Retained Labs"],
    ],
    fields: [["software", "Software Engineering"]],
    states: [["NY", "New York"]],
  });
  const time = Date.now(),
    descriptor = {
      version: 1,
      origin,
      deadlineMs: 10000,
      predecessor: { genesis: true },
      policy: {
        from: "InternScout <sender@example.test>",
        postalAddress: "1 Fixture Avenue",
        cap: 3,
        maxCandidates: 1,
        maxExpired: 1,
        transportTimeoutMs: 1000,
      },
      release: {
        catalogUrl: origin + "/current.json",
        labelsUrl: origin + "/labels.json",
        catalogSha256,
        sourceSha256,
        labelsSha256: await sha(labels),
        notBefore: time - 1000,
        expiresAt: time + 60000,
        maxCatalogBytes: 8192,
        maxLabelBytes: 8192,
        maxKeys: 20,
      },
    };
  const bodies = new Map([
    [descriptor.release.catalogUrl, catalog],
    [descriptor.release.labelsUrl, labels],
    [origin + "/prior.json", catalog],
  ]);
  const get = vi.fn(async (url) => reply(url, bodies.get(url)));
  const binding = { send: vi.fn(async () => ({ messageId: "synthetic-message" })) };
  return {
    descriptor,
    bodies,
    get,
    binding,
    time,
    bindings: {
      DB: env.DB,
      EMAIL: binding,
      FOLLOW_LINKS_CRON: cron,
      FOLLOW_LINKS_ENABLED: "1",
      FOLLOW_LINKS_RELEASE: JSON.stringify(descriptor),
    },
  };
}
function scheduled(bindings, eventCron = cron) {
  const pending = [];
  worker.scheduled({ cron: eventCron, scheduledTime: 0 }, bindings, {
    waitUntil: (p) => pending.push(p),
  });
  return Promise.all(pending);
}
async function queue() {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  // Fixture isolation only; the deployed runner has no owner reset operation.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM follow_subscribers"),
    env.DB.prepare("DELETE FROM follow_send_budget"),
    env.DB.prepare(
      "UPDATE follow_delivery_owner SET phase='ready',next_kind='confirmation',confirmation_id=NULL,confirmation_expires_at=NULL,management_id=NULL,management_expires_at=NULL",
    ),
  ]);
  await requestFollowConfirmation(
    env.DB,
    "reader@example.test",
    { kind: "company", company: "retained" },
    Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, new Set(v)])),
    new Date(),
  );
}

it("actual scheduled entry stays closed for missing/off/mismatched configuration", async () => {
  const f = await fixture(),
    db = { prepare: vi.fn(), batch: vi.fn() };
  vi.stubGlobal("fetch", f.get);
  for (const enabled of [undefined, "0", true])
    expect(await scheduled({ ...f.bindings, DB: db, FOLLOW_LINKS_ENABLED: enabled })).toEqual([]);
  for (const selected of [undefined, "", "12 3 * * *"])
    expect(await scheduled({ ...f.bindings, DB: db, FOLLOW_LINKS_CRON: selected })).toEqual([]);
  expect(await scheduled({ ...f.bindings, DB: db, FOLLOW_LINKS_RELEASE: undefined })).toEqual([
    { status: "unavailable" },
  ]);
  expect(f.get).not.toHaveBeenCalled();
  expect(db.prepare).not.toHaveBeenCalled();
});

it("off, unknown and disabled maintenance collisions read no release, DB or EMAIL getter", async () => {
  const read = vi.fn(() => {
    throw Error("must remain untouched");
  });
  const guarded = (extra) =>
    Object.defineProperties(
      { FOLLOW_LINKS_CRON: cron, ...extra },
      Object.fromEntries(
        ["FOLLOW_LINKS_RELEASE", "DB", "EMAIL"].map((key) => [key, { get: read }]),
      ),
    );
  expect(await scheduled(guarded({}))).toEqual([]);
  expect(await scheduled(guarded({ FOLLOW_LINKS_ENABLED: "1" }), "12 3 * * *")).toEqual([]);
  expect(
    await scheduled(guarded({ FOLLOW_LINKS_ENABLED: "1", FOLLOW_MAINTENANCE_CRON: cron })),
  ).toEqual([]);
  expect(read).not.toHaveBeenCalled();
});

it("all existing cron branches retain priority and collisions never acquire link inputs", async () => {
  // Compare actual branch invocations with the link option absent/present, without executing jobs.
  const f = await fixture();
  vi.stubGlobal("fetch", f.get);
  for (const selected of ["4,34 * * * *", "27 7 * * *", "47 7 * * *", "17 7 * * *", "13 2 * * *"]) {
    const capture = (bindings) => {
      const jobs = [],
        db = {
          prepare: () => ({
            bind() {
              return this;
            },
            all: async () => ({ success: true, results: [] }),
            run: async () => ({ success: true, meta: { changes: 0 } }),
            first: async () => null,
          }),
          batch: async () => [],
        };
      worker.scheduled(
        { cron: selected },
        { ...bindings, DB: db, FOLLOW_MAINTENANCE_CRON: "13 2 * * *" },
        { waitUntil: (p) => jobs.push(Promise.resolve(p).catch(() => {})) },
      );
      return jobs;
    };
    const baseline = capture({}),
      actual = capture({ ...f.bindings, FOLLOW_LINKS_CRON: selected });
    expect(actual.length).toBe(baseline.length);
    await Promise.all([...baseline, ...actual]);
  }
  expect(f.get).not.toHaveBeenCalled();
  expect(f.binding.send).not.toHaveBeenCalled();
});

it("malformed descriptor, pins, sender, bounds and decoded duplicate members do no I/O", async () => {
  const f = await fixture(),
    db = { prepare: vi.fn(), batch: vi.fn() };
  const variants = [
    null,
    {},
    { ...f.descriptor, version: 2 },
    { ...f.descriptor, deadlineMs: 0 },
    { ...f.descriptor, deadlineMs: 2147483648 },
    { ...f.descriptor, origin: "https://other.test" },
  ];
  for (const patch of [
    { catalogUrl: origin + "/current.json?" },
    { labelsUrl: origin + "/labels.json#" },
    { labelsUrl: "https://other.test/labels.json" },
    { labelsSha256: "bad" },
    { maxKeys: 10001 },
    { maxCatalogBytes: 1000001 },
    { maxLabelBytes: 2000001 },
    { expiresAt: f.descriptor.release.notBefore },
  ])
    variants.push({ ...f.descriptor, release: { ...f.descriptor.release, ...patch } });
  for (const patch of [
    { cap: 0 },
    { maxCandidates: 65 },
    { maxExpired: 129 },
    { transportTimeoutMs: 10001 },
    { from: "not an address" },
  ])
    variants.push({ ...f.descriptor, policy: { ...f.descriptor.policy, ...patch } });
  variants.push(
    { ...f.descriptor, predecessor: {} },
    {
      ...f.descriptor,
      predecessor: {
        url: f.descriptor.release.catalogUrl,
        catalogSha256: f.descriptor.release.catalogSha256,
        sourceSha256: f.descriptor.release.sourceSha256,
      },
    },
  );
  const raws = variants.map((v) => JSON.stringify(v));
  raws.push(JSON.stringify(f.descriptor).replace('"version":1', '"version":1,"vers\\u0069on":1'));
  for (const raw of raws)
    expect(
      await runFollowScheduledLinks(
        { ...f.bindings, DB: db, FOLLOW_LINKS_RELEASE: raw },
        { fetch: f.get },
      ),
    ).toEqual({ status: "unavailable" });
  expect(f.get).not.toHaveBeenCalled();
  expect(db.prepare).not.toHaveBeenCalled();
  expect(f.binding.send).not.toHaveBeenCalled();
});

it("actual scheduled entry delivers retained scope through pinned predecessor and native owner", async () => {
  await queue();
  const f = await fixture();
  f.descriptor.predecessor = {
    url: origin + "/prior.json",
    catalogSha256: f.descriptor.release.catalogSha256,
    sourceSha256: f.descriptor.release.sourceSha256,
  };
  vi.stubGlobal("fetch", f.get);
  expect(
    await scheduled({ ...f.bindings, FOLLOW_LINKS_RELEASE: JSON.stringify(f.descriptor) }),
  ).toEqual([{ status: "processed" }]);
  expect(f.get.mock.calls.map(([url]) => url)).toEqual([
    origin + "/prior.json",
    origin + "/current.json",
    origin + "/labels.json",
  ]);
  expect(f.binding.send).toHaveBeenCalledOnce();
  expect(f.binding.send.mock.calls[0][0].text).toContain("Retained Labs");
});

it("holds crossed or incomplete raw releases before owner access", async () => {
  const f = await fixture(),
    db = { prepare: vi.fn(), batch: vi.fn() };
  for (const which of ["catalog", "labels", "predecessor"]) {
    const d = structuredClone(f.descriptor);
    if (which === "predecessor")
      d.predecessor = {
        url: origin + "/prior.json",
        catalogSha256: "b".repeat(64),
        sourceSha256: d.release.sourceSha256,
      };
    else d.release[which + "Sha256"] = "b".repeat(64);
    expect(
      await runFollowScheduledLinks(
        { ...f.bindings, DB: db, FOLLOW_LINKS_RELEASE: JSON.stringify(d) },
        { fetch: f.get },
      ),
    ).toEqual({ status: "unavailable" });
  }
  expect(db.prepare).not.toHaveBeenCalled();
  expect(f.binding.send).not.toHaveBeenCalled();
});

it("shares a monotonic deadline across reads with a frozen wall clock", async () => {
  const f = await fixture(),
    db = { prepare: vi.fn() },
    d = f.descriptor;
  d.deadlineMs = 10;
  let mono = 0;
  const get = vi.fn(async (url) => {
    mono += 6;
    return reply(url, f.bodies.get(url));
  });
  expect(
    await runFollowScheduledLinks(
      { ...f.bindings, DB: db, FOLLOW_LINKS_RELEASE: JSON.stringify(d) },
      { fetch: get, now: () => new Date(f.time), monotonicNow: () => mono },
    ),
  ).toEqual({ status: "unavailable" });
  expect(get).toHaveBeenCalledTimes(2);
  expect(db.prepare).not.toHaveBeenCalled();
});

it("rejects redirects, wrong final URL and oversized streams, cancelling late fetch", async () => {
  const f = await fixture(),
    db = { prepare: vi.fn() };
  for (const get of [
    async (url) => reply(url, null, { status: 302 }),
    async () => reply(origin + "/wrong", f.bodies.get(f.descriptor.release.catalogUrl)),
    async (url) => reply(url, new Uint8Array(8193)),
  ])
    expect(await runFollowScheduledLinks({ ...f.bindings, DB: db }, { fetch: get })).toEqual({
      status: "unavailable",
    });
  const late = deferred(),
    cancel = vi.fn();
  let signal;
  const d = { ...f.descriptor, deadlineMs: 10 };
  expect(
    await runFollowScheduledLinks(
      { ...f.bindings, DB: db, FOLLOW_LINKS_RELEASE: JSON.stringify(d) },
      {
        fetch: (_url, init) => {
          signal = init.signal;
          return late.promise;
        },
      },
    ),
  ).toEqual({ status: "unavailable" });
  expect(signal.aborted).toBe(true);
  late.resolve(reply(d.release.catalogUrl, new ReadableStream({ cancel })));
  await new Promise((r) => setTimeout(r, 10));
  expect(cancel).toHaveBeenCalledOnce();
  expect(db.prepare).not.toHaveBeenCalled();
});

it("snapshots descriptor and binding before fetch and holds elapsed release before owner", async () => {
  const f = await fixture(),
    db = { prepare: vi.fn() },
    replacement = vi.fn();
  let at = f.time;
  expect(
    await runFollowScheduledLinks(
      { ...f.bindings, DB: db },
      {
        now: () => new Date(at),
        fetch: async (url) => {
          at = f.descriptor.release.expiresAt;
          return reply(url, f.bodies.get(url));
        },
      },
    ),
  ).toEqual({ status: "unavailable" });
  expect(db.prepare).not.toHaveBeenCalled();
  await queue();
  const bindings = { ...f.bindings };
  expect(
    await runFollowScheduledLinks(bindings, {
      fetch: async (url) => {
        bindings.FOLLOW_LINKS_RELEASE = "{}";
        bindings.EMAIL = { send: replacement };
        return reply(url, f.bodies.get(url));
      },
    }),
  ).toEqual({ status: "processed" });
  expect(f.binding.send).toHaveBeenCalledOnce();
  expect(replacement).not.toHaveBeenCalled();
});

it("late owner acquisition holds without send, and restart cannot release that hold", async () => {
  await queue();
  const f = await fixture();
  let at = f.time;
  const db = {
    prepare: (sql) => env.DB.prepare(sql),
    batch: async (statements) => {
      const rows = await env.DB.batch(statements);
      at = f.descriptor.release.expiresAt;
      return rows;
    },
  };
  expect(
    await runFollowScheduledLinks(
      { ...f.bindings, DB: db },
      { fetch: f.get, now: () => new Date(at) },
    ),
  ).toEqual({ status: "held" });
  expect(f.binding.send).not.toHaveBeenCalled();
  expect(await runFollowScheduledLinks(f.bindings, { fetch: f.get })).toEqual({ status: "held" });
  expect((await env.DB.prepare("SELECT phase FROM follow_delivery_owner").first()).phase).toBe(
    "held",
  );
});

it("does not lose retained predecessor keys or accept incomplete same-pin labels", async () => {
  const f = await fixture(),
    db = { prepare: vi.fn() };
  const prior = JSON.parse(new TextDecoder().decode(f.bodies.get(origin + "/prior.json")));
  prior.valid.companies = ["fixture", "missing", "retained"];
  const priorBytes = pack(prior);
  f.bodies.set(origin + "/prior.json", priorBytes);
  const d = structuredClone(f.descriptor);
  d.predecessor = {
    url: origin + "/prior.json",
    catalogSha256: await sha(priorBytes),
    sourceSha256: d.release.sourceSha256,
  };
  expect(
    await runFollowScheduledLinks(
      { ...f.bindings, DB: db, FOLLOW_LINKS_RELEASE: JSON.stringify(d) },
      { fetch: f.get },
    ),
  ).toEqual({ status: "unavailable" });
  const labels = JSON.parse(new TextDecoder().decode(f.bodies.get(d.release.labelsUrl)));
  labels.companies.pop();
  const labelBytes = pack(labels);
  f.bodies.set(d.release.labelsUrl, labelBytes);
  d.predecessor = { genesis: true };
  d.release.labelsSha256 = await sha(labelBytes);
  expect(
    await runFollowScheduledLinks(
      { ...f.bindings, DB: db, FOLLOW_LINKS_RELEASE: JSON.stringify(d) },
      { fetch: f.get },
    ),
  ).toEqual({ status: "unavailable" });
  expect(db.prepare).not.toHaveBeenCalled();
});

it("the acquisition deadline still fences #629 hashing before ownership", async () => {
  const f = await fixture(),
    db = { prepare: vi.fn() };
  let mono = 0;
  const original = crypto.subtle.digest.bind(crypto.subtle);
  const spy = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (...args) => {
    const result = await original(...args);
    mono = f.descriptor.deadlineMs;
    return result;
  });
  try {
    expect(
      await runFollowScheduledLinks(
        { ...f.bindings, DB: db },
        { fetch: f.get, now: () => new Date(f.time), monotonicNow: () => mono },
      ),
    ).toEqual({ status: "unavailable" });
    expect(db.prepare).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

it("competing scheduled invocations share the owner while one synthetic send is unresolved", async () => {
  await queue();
  const f = await fixture(),
    entered = deferred(),
    completion = deferred();
  f.binding.send.mockImplementation(() => {
    entered.resolve();
    return completion.promise;
  });
  vi.stubGlobal("fetch", f.get);
  const first = scheduled(f.bindings);
  await entered.promise;
  expect(await scheduled(f.bindings)).toEqual([{ status: "held" }]);
  expect(f.binding.send).toHaveBeenCalledOnce();
  completion.resolve({ messageId: "synthetic-message" });
  expect(await first).toEqual([{ status: "processed" }]);
});
