import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { runFollowArchiveDeployment } from "../src/follow-archive-deployment.js";
import { runFollowArchiveRelease } from "../src/follow-archive-release.js";
import { prepareFollowCatalogDeployment } from "../src/follow-signup-release.js";
import { followSnapshotDigest } from "../src/follow-matching.js";
import { requestFollow, mintFollowToken, confirmFollow } from "../src/follows.js";

const hour = 3600000,
  origin = "https://internscout.org",
  encode = (s) => new TextEncoder().encode(s);
const sha = (s) => followSnapshotDigest(encode(s));
const iso = (n) => new Date(n).toISOString();
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare("DELETE FROM follow_subscribers").run();
  await env.DB.prepare("DELETE FROM follow_digest_days").run();
});
afterEach(() => vi.unstubAllGlobals());

async function fixture(genesis = false, subscribers = 1) {
  const time = Date.now(),
    generated = time - hour,
    confirmed = generated - hour;
  const sets = {
    companies: new Set(["fixture"]),
    fields: new Set(["swe"]),
    states: new Set(["MA"]),
  };
  for (let index = 0; index < subscribers; index++) {
    const scope = await requestFollow(
      env.DB,
      `synthetic${index}@example.test`,
      { kind: "company", company: "fixture" },
      sets,
      new Date(confirmed),
    );
    await confirmFollow(
      env.DB,
      await mintFollowToken(
        env.DB,
        scope.subscriberId,
        "confirm",
        { scopeKey: scope.scopeKey },
        new Date(confirmed),
      ),
      new Date(confirmed),
    );
  }
  const snapshot = JSON.stringify({
    version: 1,
    complete: true,
    generated_at: iso(generated),
    covers_after: iso(confirmed),
    roles: [
      {
        id: "a".repeat(16),
        company_key: "fixture",
        field_tags: ["swe"],
        states: ["MA"],
        first_seen: iso(generated - 1),
        status: "open",
        company_name: "Fixture",
        title: "Synthetic role",
        location: "Boston",
        apply_url: "https://jobs.example.test/role",
      },
    ],
  });
  const hash = await sha(snapshot);
  const manifest = JSON.stringify({
    checked_at: iso(generated),
    entries: [
      {
        bytes: encode(snapshot).length,
        enqueue_until: iso(generated + 3 * hour),
        generated_at: iso(generated),
        retain_until: iso(generated + 52 * hour),
        sha256: hash,
      },
    ],
    high_water: iso(generated),
    latest: hash,
    version: 1,
  });
  const catalog = (source) =>
    JSON.stringify({
      version: 1,
      source_sha256: source.repeat(64),
      signup: { companies: ["fixture"], fields: ["swe"], states: ["MA"] },
      valid: { companies: ["fixture"], fields: ["swe"], states: ["MA"] },
      aliases: [["Fixture", "fixture"]],
    });
  const currentUrl = `${origin}/data/follows/current.json`,
    priorUrl = `${origin}/data/follows/prior.json`,
    indexUrl = `${origin}/data/follows/index.json`;
  const files = new Map([
    [currentUrl, catalog("a")],
    [priorUrl, catalog("b")],
    [indexUrl, manifest],
    [`${origin}/data/follows/${hash}.json`, snapshot],
  ]);
  const input = {
    version: 1,
    catalog: {
      version: 1,
      origin,
      release: {
        url: currentUrl,
        sourceSha256: "a".repeat(64),
        catalogSha256: await sha(catalog("a")),
        notBefore: time - hour,
        expiresAt: time + hour,
      },
      predecessor: genesis
        ? { genesis: true }
        : { url: priorUrl, sourceSha256: "b".repeat(64), catalogSha256: await sha(catalog("b")) },
      maxBytes: 4000,
      maxKeys: 10,
      deadlineMs: 10000,
    },
    archive: {
      indexUrl,
      indexSha256: await sha(manifest),
      bounds: {
        maxManifestBytes: 4000,
        maxEntries: 3,
        maxArchiveBytes: 16000,
        maxEnqueueAgeMs: 3 * hour,
        publishMarginMs: hour,
        deadlineMs: 10000,
      },
    },
    limits: {
      maxBytes: 8000,
      maxRoles: 10,
      maxFollows: 10,
      maxMatches: 10,
      maxResultBytes: 8000,
      maxTextBytes: 2000,
      maxWindowMs: 48 * hour,
    },
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
  };
  const gets = [];
  let wall = time,
    mono = 0;
  const options = {
    enabled: true,
    db: env.DB,
    now: () => wall,
    monotonicNow: () => mono,
    fetch: async (url, init) => {
      gets.push(url);
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("manual");
      if (!files.has(url)) throw Error("Unexpected synthetic URL");
      const r = new Response(files.get(url));
      Object.defineProperty(r, "url", { value: url });
      return r;
    },
  };
  return {
    input,
    options,
    files,
    gets,
    currentUrl,
    priorUrl,
    indexUrl,
    time,
    run: () => runFollowArchiveDeployment({ ...options, descriptor: JSON.stringify(input) }),
    wall: (n) => {
      wall = n;
    },
    mono: (n) => {
      mono = n;
    },
    jobs: () => env.DB.prepare("SELECT count(*) AS n FROM follow_digest_outbox").first("n"),
  };
}

const archiveCron = "19 3 * * *";

function scheduledArchive(bindings, cron = archiveCron) {
  const pending = [];
  worker.scheduled({ cron }, bindings, { waitUntil: (job) => pending.push(job) });
  return Promise.all(pending);
}

it("scheduled archive requires an exact configured cron and literal opt-in", async () => {
  const read = vi.fn(() => {
    throw Error("unexpected archive binding read");
  });
  const bindings = (selection) =>
    Object.defineProperties(
      { FOLLOW_ARCHIVE_CRON: archiveCron, ...selection },
      { FOLLOW_ARCHIVE_RELEASE: { get: read }, DB: { get: read }, EMAIL: { get: read } },
    );
  for (const enabled of [undefined, "0", true])
    expect(await scheduledArchive(bindings({ FOLLOW_ARCHIVE_ENABLED: enabled }))).toEqual([]);
  expect(await scheduledArchive(bindings({ FOLLOW_ARCHIVE_ENABLED: "1" }), "21 3 * * *")).toEqual(
    [],
  );
  for (const setting of ["FOLLOW_LINKS_CRON", "FOLLOW_MAINTENANCE_CRON"]) {
    expect(
      await scheduledArchive(bindings({ FOLLOW_ARCHIVE_ENABLED: "1", [setting]: archiveCron })),
    ).toEqual([]);
  }
  expect(read).not.toHaveBeenCalled();
});

it("scheduled archive returns unavailable for a missing or inaccessible release", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const bindings = { FOLLOW_ARCHIVE_CRON: archiveCron, FOLLOW_ARCHIVE_ENABLED: "1", DB: env.DB };
  const unavailable = [{ status: "unavailable", fetchCalls: 0 }];
  expect(await scheduledArchive(bindings)).toEqual(unavailable);
  Object.defineProperty(bindings, "FOLLOW_ARCHIVE_RELEASE", {
    get() {
      throw Error("unavailable binding");
    },
  });
  expect(await scheduledArchive(bindings)).toEqual(unavailable);
  expect(fetch).not.toHaveBeenCalled();
});

it("existing clock, billing, reports and daily work retain priority", async () => {
  const archiveSelector = vi.fn(() => {
    throw Error("unexpected archive cron read");
  });
  const descriptor = vi.fn(() => {
    throw Error("unexpected archive descriptor read");
  });
  const fetch = vi.fn(async () => {
    throw Error("unexpected network");
  });
  vi.stubGlobal("fetch", fetch);
  const db = {
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
  const invoke = (cron, extra, selector) => {
    const jobs = [];
    const bindings = Object.defineProperty({ DB: db, ...extra }, "FOLLOW_ARCHIVE_RELEASE", {
      get: descriptor,
    });
    if (selector) Object.defineProperty(bindings, "FOLLOW_ARCHIVE_CRON", { get: selector });
    worker.scheduled({ cron }, bindings, {
      waitUntil: (job) => jobs.push(Promise.resolve(job).catch(() => {})),
    });
    return jobs;
  };
  for (const cron of ["4,34 * * * *", "27 7 * * *", "47 7 * * *", "17 7 * * *"]) {
    const previous = invoke(cron, {});
    const selected = invoke(cron, { FOLLOW_ARCHIVE_CRON: cron, FOLLOW_ARCHIVE_ENABLED: "1" });
    expect(selected).toHaveLength(previous.length);
    await Promise.all([...previous, ...selected]);
  }
  const daily = invoke("17 7 * * *", { FOLLOW_ARCHIVE_ENABLED: "1" }, archiveSelector);
  expect(daily).toHaveLength(1);
  await Promise.all(daily);
  expect(archiveSelector).not.toHaveBeenCalled();
  expect(descriptor).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
});

it("scheduled archive enqueues one bounded pass and leaves email and delivery ownership untouched", async () => {
  const f = await fixture(false, 2);
  f.input.budget.maxPages = 1;
  vi.stubGlobal("fetch", f.options.fetch);
  const email = vi.fn(() => {
    throw Error("unexpected email binding read");
  });
  const bindings = Object.defineProperty(
    {
      FOLLOW_ARCHIVE_CRON: archiveCron,
      FOLLOW_ARCHIVE_ENABLED: "1",
      FOLLOW_ARCHIVE_RELEASE: JSON.stringify(f.input),
      DB: env.DB,
    },
    "EMAIL",
    { get: email },
  );
  const owner = () => env.DB.prepare("SELECT * FROM follow_delivery_owner").first();
  const before = await owner();
  expect(await scheduledArchive(bindings)).toMatchObject([
    { status: "partial", pages: 1, subscribers: 1, fetchCalls: 4, counts: { queued: 1 } },
  ]);
  expect(await f.jobs()).toBe(1);
  expect(await owner()).toEqual(before);
  expect(email).not.toHaveBeenCalled();
  expect(f.gets).toEqual([f.priorUrl, f.currentUrl, f.indexUrl, [...f.files.keys()].at(-1)]);
  f.input.budget.maxPages = 2;
  bindings.FOLLOW_ARCHIVE_RELEASE = JSON.stringify(f.input);
  expect(await scheduledArchive(bindings)).toMatchObject([
    { status: "pass-complete", pages: 2, subscribers: 2, counts: { queued: 2 } },
  ]);
  expect(await f.jobs()).toBe(2);
  expect(await owner()).toEqual(before);
  expect(email).not.toHaveBeenCalled();
});

it("default off does not inspect deployment inputs", async () => {
  expect(
    await runFollowArchiveDeployment({
      get descriptor() {
        throw Error("read");
      },
    }),
  ).toEqual({ status: "disabled" });
});
it("real runner enqueues once with explicit genesis and independent pinned predecessor", async () => {
  for (const genesis of [true, false]) {
    await env.DB.prepare("DELETE FROM follow_subscribers").run();
    const f = await fixture(genesis),
      result = await f.run();
    expect(result.status).toBe("pass-complete");
    expect(result.counts).toEqual({ queued: 1 });
    expect(await f.jobs()).toBe(1);
    expect(result.fetchCalls).toBe(genesis ? 3 : 4);
    expect(f.gets.filter((u) => u === f.currentUrl)).toHaveLength(1);
    expect(f.gets).toEqual([
      ...(genesis ? [] : [f.priorUrl]),
      f.currentUrl,
      f.indexUrl,
      [...f.files.keys()].at(-1),
    ]);
  }
});
it("malformed or insufficient deployment authority makes no reads or writes", async () => {
  const f = await fixture(),
    original = JSON.stringify(f.input);
  const mutations = [
    (x) => delete x.catalog.predecessor,
    (x) => (x.catalog.predecessor = { genesis: false }),
    (x) => (x.version = 2),
    (x) => (x.extra = true),
    (x) => (x.catalog.origin = "https://example.test"),
    (x) => (x.catalog.predecessor.url = x.catalog.release.url),
    (x) => (x.budget.maxFetches = 3),
    (x) => (x.budget.maxD1Calls = 3),
    (x) => (x.budget.maxStatements = 6),
    (x) => (x.archive.indexSha256 = "bad"),
    (x) => (x.limits.maxRoles = 0),
    (x) => (x.archive.bounds.extra = 1),
  ];
  for (const mutate of mutations) {
    const x = JSON.parse(original);
    mutate(x);
    expect(
      (await runFollowArchiveDeployment({ ...f.options, descriptor: JSON.stringify(x) })).status,
    ).toBe("unavailable");
  }
  for (const descriptor of [
    original.replace('"version":1', '"version":1,"\\u0076ersion":1'),
    " ".repeat(8193) + original,
  ])
    expect((await runFollowArchiveDeployment({ ...f.options, descriptor })).status).toBe(
      "unavailable",
    );
  expect(f.gets).toEqual([]);
  expect(await f.jobs()).toBe(0);
});
it("crossed predecessor or manifest bytes fail closed without later operations", async () => {
  const f = await fixture();
  f.files.set(f.priorUrl, f.files.get(f.currentUrl));
  expect((await f.run()).status).toBe("unavailable");
  expect(f.gets).toEqual([f.priorUrl]);
  expect(await f.jobs()).toBe(0);
  const g = await fixture(true);
  g.files.set(g.indexUrl, "{}");
  expect((await g.run()).status).toBe("unavailable");
  expect(g.gets).toEqual([g.currentUrl, g.indexUrl]);
  expect(await g.jobs()).toBe(0);
});
it("predecessor elapsed wall or monotonic time cannot receive a fresh runner deadline", async () => {
  for (const clock of ["wall", "mono"]) {
    const f = await fixture(),
      get = f.options.fetch;
    f.options.fetch = async (...args) => {
      const r = await get(...args);
      f[clock](clock === "wall" ? f.time + 10000 : 10000);
      return r;
    };
    expect((await f.run()).status).toBe("unavailable");
    expect(f.gets).toEqual([f.priorUrl]);
    expect(await f.jobs()).toBe(0);
  }
});
it("combined predecessor and current elapsed time is bounded by one deadline", async () => {
  const f = await fixture(),
    get = f.options.fetch;
  let n = 0;
  f.options.fetch = async (...args) => {
    const r = await get(...args);
    f.mono(++n * 6000);
    return r;
  };
  expect((await f.run()).status).toBe("unavailable");
  expect(f.gets).toEqual([f.priorUrl, f.currentUrl]);
  expect(await f.jobs()).toBe(0);
});
it("clock regression and rejected async samples stop the pass before further I/O", async () => {
  const f = await fixture();
  f.options.now = () => Promise.reject(Error("synthetic"));
  expect((await f.run()).status).toBe("unavailable");
  expect(f.gets).toEqual([]);
  const g = await fixture(),
    get = g.options.fetch;
  g.options.fetch = async (...args) => {
    const r = await get(...args);
    g.wall(g.time - 1);
    return r;
  };
  expect((await g.run()).status).toBe("unavailable");
  expect(g.gets).toEqual([g.priorUrl]);
});
it("late D1 acknowledgement cannot authorize another page or claim rollback", async () => {
  const f = await fixture();
  f.options.db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (list) => {
      const r = await env.DB.batch(list);
      f.mono(10000);
      return r;
    },
  };
  expect((await f.run()).status).toBe("unavailable");
  expect(await f.jobs()).toBe(1);
  expect(f.gets).toHaveLength(4);
});

it("pinned predecessor continuity must survive in current valid sets", async () => {
  const f = await fixture(),
    prior = JSON.parse(f.files.get(f.priorUrl));
  prior.valid.companies.push("retained");
  const bytes = JSON.stringify(prior);
  f.files.set(f.priorUrl, bytes);
  f.input.catalog.predecessor.catalogSha256 = await sha(bytes);
  expect((await f.run()).status).toBe("unavailable");
  expect(f.gets).toEqual([f.priorUrl, f.currentUrl]);
  expect(await f.jobs()).toBe(0);
});

it("late headers and stalled predecessor bodies cancel without a current-catalog read", async () => {
  for (const stalledBody of [false, true]) {
    const f = await fixture();
    f.input.budget.deadlineMs = 20;
    let release,
      canceled = 0,
      aborted = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          canceled++;
        },
      }),
    );
    Object.defineProperty(response, "url", { value: f.priorUrl });
    f.options.fetch = async (url, init) => {
      f.gets.push(url);
      init.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return stalledBody
        ? response
        : new Promise((resolve) => {
            release = resolve;
          });
    };
    expect((await f.run()).status).toBe("unavailable");
    if (release) release(response);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(aborted).toBe(true);
    expect(canceled).toBe(1);
    expect(f.gets).toEqual([f.priorUrl]);
    expect(await f.jobs()).toBe(0);
  }
});

it("unsafe plus-one scope bound and colliding acquisition targets reject before GET or D1", async () => {
  const f = await fixture();
  let prepares = 0,
    batches = 0;
  f.options.db = {
    prepare() {
      prepares++;
      throw Error("unexpected");
    },
    batch() {
      batches++;
      throw Error("unexpected");
    },
  };
  const base = JSON.stringify(f.input);
  const cases = [(x) => (x.limits.maxFollows = Number.MAX_SAFE_INTEGER)];
  for (const where of ["release", "predecessor"])
    for (const path of [
      "/data/follows/index.json",
      "/%64ata/follows/index.json",
      "/data%2Ffollows/index.json",
      "/data/follows/%2569ndex.json",
    ])
      cases.push((x) => (x.catalog[where].url = origin + path));
  cases.push((x) => (x.catalog.predecessor.url = origin + "/data/follows/%63urrent.json"));
  for (const mutate of cases) {
    const input = JSON.parse(base);
    mutate(input);
    expect(
      (await runFollowArchiveDeployment({ ...f.options, descriptor: JSON.stringify(input) }))
        .status,
    ).toBe("unavailable");
  }
  expect(f.gets).toEqual([]);
  expect(prepares).toBe(0);
  expect(batches).toBe(0);
  expect(await f.jobs()).toBe(0);
});

it("SQL rejects an unadmitted batch after the original outer wall deadline", async () => {
  const f = await fixture(true);
  f.input.budget.deadlineMs = 1000;
  let samples = 0,
    started,
    attempted = false;
  f.options.now = () => {
    if (++samples === 1) started = Date.now() - 750;
    return samples <= 2 ? started : Date.now();
  };
  f.options.monotonicNow = () => 0;
  f.options.db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (list) => {
      attempted = true;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, started + 1050 - Date.now())));
      expect(Date.now()).toBeGreaterThanOrEqual(started + 1000);
      return env.DB.batch(list);
    },
  };
  expect((await f.run()).status).toBe("unavailable");
  expect(attempted).toBe(true);
  expect(await f.jobs()).toBe(0);
});

it("SQL clips admission for monotonic time consumed before the inner runner starts", async () => {
  const f = await fixture(true);
  f.input.budget.deadlineMs = 1000;
  let samples = 0,
    late = false,
    attempts = 0;
  f.options.now = Date.now;
  f.options.monotonicNow = () => (++samples <= 2 ? 0 : late ? 1050 : 750.2);
  f.options.db = {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (list) => {
      attempts++;
      await new Promise((resolve) => setTimeout(resolve, 300));
      late = true;
      return env.DB.batch(list);
    },
  };
  expect((await f.run()).status).toBe("unavailable");
  expect(attempts).toBe(1);
  expect(await f.jobs()).toBe(0);
});

it("optional write ceiling rejects invalid synchronous receipts before an atomic batch", async () => {
  const f = await fixture(true);
  let batches = 0;
  const { policy } = prepareFollowCatalogDeployment(f.input.catalog);
  const options = {
    ...f.options,
    ...f.input,
    enabled: true,
    catalog: policy,
    db: {
      prepare: env.DB.prepare.bind(env.DB),
      batch() {
        batches++;
        throw Error("unexpected");
      },
    },
  };
  for (const value of [null, "future", NaN, Number.MAX_SAFE_INTEGER, f.time]) {
    expect((await runFollowArchiveRelease({ ...options, writeCutoff: () => value })).status).toBe(
      "unavailable",
    );
  }
  expect(
    (
      await runFollowArchiveRelease({
        ...options,
        writeCutoff: () => Promise.reject(Error("synthetic")),
      })
    ).status,
  ).toBe("unavailable");
  expect(batches).toBe(0);
  expect(await f.jobs()).toBe(0);
});
