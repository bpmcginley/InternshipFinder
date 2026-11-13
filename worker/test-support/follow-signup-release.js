import assert from "node:assert/strict";
import worker, { handle } from "../src/index.js";
import { prepareFollowSignupDeployment } from "../src/follow-signup-release.js";
import { createSession } from "../src/session.js";

const origin = "https://internscout.org";
const enc = new TextEncoder();
const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n");
const request = (email = "reader@example.test", extra = {}) =>
  new Request("https://api.example.test/follows/signup", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...extra.headers },
    body: JSON.stringify({
      email,
      link: !!extra.link,
      scope: { kind: "company", company: "fixture" },
    }),
  });
const reply = (bytes, url) => {
  const response = new Response(bytes);
  Object.defineProperty(response, "url", { value: url });
  return response;
};
async function fixture({ retained = true, genesis = false } = {}) {
  const now = Date.now(),
    source = "a".repeat(64);
  const catalog = (old) =>
    enc.encode(
      JSON.stringify({
        version: 1,
        source_sha256: source,
        signup: { companies: ["fixture"], fields: ["biology"], states: ["MA"] },
        valid: {
          companies: old || retained ? ["fixture", "retired"] : ["fixture"],
          fields: ["biology"],
          states: ["MA"],
        },
        aliases: [["Fixture", "fixture"]],
      }),
    );
  const prior = catalog(true),
    current = catalog(false);
  const pin = async (bytes, name) => ({
    url: `${origin}/synthetic-${name}.json`,
    sourceSha256: source,
    catalogSha256: [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
      .map((v) => v.toString(16).padStart(2, "0"))
      .join(""),
  });
  const descriptor = {
    version: 1,
    origin,
    dailyLimit: 20,
    deadlineMs: 1000,
    maxBytes: 1000000,
    maxKeys: 10000,
    release: { ...(await pin(current, "current")), notBefore: now - 1000, expiresAt: now + 60000 },
    predecessor: genesis ? { genesis: true } : await pin(prior, "prior"),
  };
  const env = (db) => ({
    DB: db,
    FOLLOW_SIGNUP_ENABLED: "1",
    FOLLOW_SIGNUP_RELEASE: JSON.stringify(descriptor),
  });
  let calls = 0;
  const fetch = async (url, init) => {
    calls++;
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    assert.equal(init.headers, undefined);
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok([descriptor.release.url, descriptor.predecessor.url].includes(url));
    return reply(url === descriptor.release.url ? current : prior, url);
  };
  return { now, descriptor, env, prior, current, fetch, calls: () => calls };
}

export async function deploymentDescriptorRejectsMalformedAuthorityBeforeBodyOrIO() {
  const f = await fixture();
  let io = 0;
  const unexpected = () => {
    io++;
    throw Error("Unexpected synthetic I/O");
  };
  const db = { prepare: unexpected, batch: unexpected };
  const raw = JSON.stringify(f.descriptor);
  const variants = [
    undefined,
    "{}",
    " ".repeat(4097),
    raw.replace('"version":1', '"version":1,"version":1'),
    raw.replace('"version":1', '"version":1,"\\u0076ersion":1'),
  ];
  for (const mutate of [
    (d) => {
      d.origin = "https://other.example.test";
    },
    (d) => {
      d.predecessor = null;
    },
    (d) => {
      d.predecessor = { genesis: false };
    },
    (d) => {
      d.release.expiresAt = f.now;
    },
    (d) => {
      d.predecessor.url = d.release.url;
    },
    (d) => {
      d.release.url += "?";
    },
    (d) => {
      d.predecessor.sourceSha256 = "x";
    },
    (d) => {
      d.maxBytes = 1000001;
    },
    (d) => {
      d.maxKeys = 10001;
    },
    (d) => {
      d.dailyLimit = 0;
    },
    (d) => {
      d.release.url = "https://internscout.org.evil.test/x";
    },
    (d) => {
      d.release.url = "https://internscout.org/a/../b";
    },
  ]) {
    const d = structuredClone(f.descriptor);
    mutate(d);
    variants.push(JSON.stringify(d));
  }
  for (const raw of variants) {
    const req = request();
    const response = await handle(req, { ...f.env(db), FOLLOW_SIGNUP_RELEASE: raw }, undefined, {
      fetch: unexpected,
      now: () => new Date(f.now),
    });
    assert.equal(response.status, 404);
    assert.equal(req.bodyUsed, false);
  }
  for (const enabled of [undefined, "0", true, "true"]) {
    assert.equal(
      (
        await handle(request(), { ...f.env(db), FOLLOW_SIGNUP_ENABLED: enabled }, undefined, {
          fetch: unexpected,
        })
      ).status,
      404,
    );
  }
  assert.equal(io, 0);
}

export async function deploymentDefaultExportAdmitsGenesisAndPinnedContinuity(db) {
  const originalFetch = globalThis.fetch;
  try {
    for (const genesis of [true, false]) {
      const f = await fixture({ genesis });
      globalThis.fetch = f.fetch;
      const response = await worker.fetch(request(`${genesis}@example.test`), f.env(db), {});
      assert.equal(response.status, 202);
      assert.equal(await response.text(), "");
      assert.equal(f.calls(), genesis ? 1 : 2);
    }
    assert.equal(await count(db, "follow_confirmation_outbox"), 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export async function deploymentContinuityFailureDoesNotSpendOrQueue(db) {
  for (const corrupt of [true, false]) {
    const f = await fixture({ retained: false });
    let reads = 0;
    const response = await handle(request(), f.env(db), undefined, {
      now: () => new Date(f.now),
      fetch: async (url, init) => {
        reads++;
        return corrupt ? reply(enc.encode("{}"), url) : f.fetch(url, init);
      },
    });
    assert.equal(response.status, 503);
    assert.equal(reads, corrupt ? 1 : 2);
    assert.equal(await count(db, "rate"), 0);
    assert.equal(await count(db, "follow_confirmation_outbox"), 0);
    assert.equal(await count(db, "follow_subscribers"), 0);
  }
}

export async function deploymentCapturesDescriptorBeforeBodyAndRetainsSessionFence(db) {
  const f = await fixture(),
    settings = f.env(db);
  let finish;
  const body = new ReadableStream({
    start(c) {
      finish = () => {
        c.enqueue(
          enc.encode(
            JSON.stringify({
              email: "captured@example.test",
              link: false,
              scope: { kind: "company", company: "fixture" },
            }),
          ),
        );
        c.close();
      };
    },
  });
  const response = handle(new Request(request(), { body, duplex: "half" }), settings, undefined, {
    fetch: f.fetch,
    now: () => new Date(f.now),
  });
  settings.FOLLOW_SIGNUP_RELEASE = "{}";
  finish();
  assert.equal((await response).status, 202);
  assert.equal(f.calls(), 2);
  const session = await createSession(
    db,
    { user: "b".repeat(64), tier: "general", provider: "google" },
    new Date(f.now),
  );
  const linked = request("linked@example.test", {
    link: true,
    headers: { Authorization: `Bearer ${session.token}` },
  });
  const linkedResponse = await handle(linked, f.env(db), undefined, {
    now: () => new Date(f.now),
    fetch: async (...args) => {
      await db.prepare("DELETE FROM sessions").run();
      return f.fetch(...args);
    },
  });
  // Existing generic outcome intentionally hides session rejection; SQL creates nothing.
  assert.equal(linkedResponse.status, 202);
  assert.equal(await count(db, "follow_confirmation_outbox"), 1);
}

export async function deploymentDeadlineIsSharedAndLateReadCannotAdmit(db) {
  const f = await fixture();
  f.descriptor.deadlineMs = 100;
  let time = f.now,
    reads = 0,
    finish,
    canceled = 0,
    signal;
  const pending = handle(request(), f.env(db), undefined, {
    now: () => new Date(time),
    fetch: async (url, init) => {
      reads++;
      if (reads === 1) {
        time += 90;
        return f.fetch(url, init);
      }
      signal = init.signal;
      return new Promise((resolve) => {
        finish = () =>
          resolve(
            reply(
              new ReadableStream({
                cancel() {
                  canceled++;
                },
              }),
              url,
            ),
          );
      });
    },
  });
  assert.equal((await pending).status, 503);
  assert.equal(reads, 2);
  assert.equal(signal.aborted, true);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(canceled, 1);
  assert.equal(await count(db, "follow_confirmation_outbox"), 0);
  assert.equal(await count(db, "rate"), 0);
}

export async function deploymentSharesFourSlotsAcrossBodiesAndBothReads(db) {
  const f = await fixture(),
    bodies = [],
    priors = [];
  f.descriptor.deadlineMs = 10000;
  let reached;
  const allReading = new Promise((resolve) => {
    reached = resolve;
  });
  const pending = Array.from({ length: 4 }, (_, i) => {
    const body = new ReadableStream({
      start(c) {
        bodies.push(() => {
          c.enqueue(
            enc.encode(
              JSON.stringify({
                email: `reader${i}@example.test`,
                link: false,
                scope: { kind: "company", company: "fixture" },
              }),
            ),
          );
          c.close();
        });
      },
    });
    return handle(new Request(request(), { body, duplex: "half" }), f.env(db), undefined, {
      now: () => new Date(f.now),
      fetch: async (url, init) => {
        if (url === f.descriptor.predecessor.url)
          return new Promise((resolve) => {
            priors.push(async () => resolve(await f.fetch(url, init)));
            if (priors.length === 4) reached();
          });
        return f.fetch(url, init);
      },
    });
  });
  const fifth = () =>
    handle(request(), f.env(db), undefined, {
      fetch: () => {
        throw Error("Fifth read");
      },
    });
  assert.equal((await fifth()).status, 503);
  assert.equal(f.calls(), 0);
  bodies.forEach((finish) => finish());
  await allReading;
  assert.equal((await fifth()).status, 503);
  assert.equal(f.calls(), 0);
  await Promise.all(priors.map((finish) => finish()));
  assert.deepEqual(
    (await Promise.all(pending)).map((r) => r.status),
    [202, 202, 202, 202],
  );
  assert.equal(f.calls(), 8);
}

export async function deploymentTechnicalCapsAccommodateTheMeasuredPublicCatalog() {
  // Synthetic scale fixture matches the measured 2,201-company public catalog count.
  const f = await fixture({ genesis: true });
  const n = 2201,
    names = Array.from({ length: n }, (_, i) => `company-${String(i).padStart(4, "0")}`);
  const value = JSON.parse(new TextDecoder().decode(f.current));
  value.signup.companies = names;
  value.valid.companies = names;
  value.aliases = names.map((name) => [name, name]);
  const bytes = enc.encode(JSON.stringify(value));
  f.descriptor.release.catalogSha256 = [
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
  ]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
  const adapter = prepareFollowSignupDeployment(JSON.stringify(f.descriptor), {
    now: () => new Date(f.now),
    fetch: async (url) => reply(bytes, url),
  });
  const result = await adapter.loadCatalog();
  assert.equal(result.status, "available");
  assert.equal(result.catalog.signup.companies.size, n);
  assert.ok(bytes.length > 100000);
  assert.ok(bytes.length < 1000000);
  assert.ok(enc.encode(JSON.stringify(f.descriptor)).length < 4096);
}

export async function deploymentMonotonicDeadlineFencesAFrozenWallClock(db) {
  const f = await fixture();
  f.descriptor.deadlineMs = 100;
  let monotonic = 0,
    reads = 0;
  const adapter = prepareFollowSignupDeployment(JSON.stringify(f.descriptor), {
    now: () => new Date(f.now),
    monotonicNow: () => monotonic,
    fetch: async (...args) => {
      reads++;
      monotonic = reads === 1 ? 90 : 100;
      return f.fetch(...args);
    },
  });
  assert.equal((await adapter.loadCatalog()).status, "unavailable");
  assert.equal(reads, 2);
  assert.equal(await count(db, "follow_confirmation_outbox"), 0);
}

export async function deploymentRealSqlExpiryFencesBothQueuePaths(db) {
  const f = await fixture();
  const { token } = await createSession(
    db,
    { user: "c".repeat(64), tier: "general", provider: "google" },
    new Date(f.now),
  );
  for (const link of [false, true]) {
    f.descriptor.release.expiresAt = Date.now() + 500;
    let batches = 0;
    const wrapped = {
      prepare: (sql) => db.prepare(sql),
      batch: async (statements) => {
        batches++;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, f.descriptor.release.expiresAt - Date.now() + 10)),
        );
        return db.batch(statements);
      },
    };
    const response = await handle(
      request(`sql-${link}@example.test`, {
        link,
        headers: { Authorization: `Bearer ${token}` },
      }),
      f.env(wrapped),
      undefined,
      { now: () => new Date(f.now), fetch: f.fetch },
    );
    assert.equal(response.status, 503);
    assert.equal(batches, 1);
    for (const table of [
      "follow_subscribers",
      "follow_subscriptions",
      "follow_confirmation_outbox",
    ])
      assert.equal(await count(db, table), 0);
  }
}

export async function deploymentRejectsAsyncClocksWithoutEscapingRejections() {
  const f = await fixture();
  let reads = 0;
  const fetch = () => {
    reads++;
    throw Error("Unexpected synthetic read");
  };
  const rejected = async () => {
    throw Error("Synthetic clock failure");
  };
  assert.throws(() =>
    prepareFollowSignupDeployment(JSON.stringify(f.descriptor), { fetch, now: rejected }),
  );
  const adapter = prepareFollowSignupDeployment(JSON.stringify(f.descriptor), {
    fetch,
    now: () => new Date(f.now),
    monotonicNow: rejected,
  });
  assert.equal((await adapter.loadCatalog()).status, "unavailable");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reads, 0);
}

export async function deploymentRejectsClockRollbackSinceTheRouteSample(db) {
  const f = await fixture();
  for (const first of [f.now + 1, f.descriptor.release.expiresAt]) {
    let samples = 0;
    const req = request();
    const response = await handle(req, f.env(db), undefined, {
      now: () => new Date(samples++ === 0 ? first : f.now),
      fetch: f.fetch,
    });
    assert.equal(response.status, 404);
    assert.equal(req.bodyUsed, false);
    assert.equal(f.calls(), 0);
    assert.equal(await count(db, "rate"), 0);
    assert.equal(await count(db, "follow_confirmation_outbox"), 0);
  }
}
