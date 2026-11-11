import assert from "node:assert/strict";
import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import { beforeEach, it } from "vitest";
import { admitEmployerPosting } from "../src/employer-posting-counts.js";
import {
  createEmployerPostingRuntime,
  employerCatalogDescriptor,
} from "../src/employer-posting-runtime.js";

const URL = "https://internscout.org/data/employer-posting-keys.json";
const published = { mode: "published", url: URL };
const config = (value = published) => ({
  EMPLOYER_POSTING_COUNTS_ENABLED: "1",
  EMPLOYER_POSTING_CATALOG: JSON.stringify(value),
});
const reply = (url, text, init) =>
  Object.defineProperty(new Response(text, init), "url", { value: url });
let address = 0,
  virtualTime;
beforeEach(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));

async function fixture() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM employer_posting_counts"),
    env.DB.prepare("DELETE FROM employer_posting_day_caps"),
    env.DB.prepare("INSERT INTO employer_posting_day_caps VALUES(date('now'),0)"),
  ]);
  const day = (await env.DB.prepare("SELECT date('now') AS day").first()).day;
  virtualTime ??= Date.parse(`${day}T00:00:00Z`);
  const at = ++virtualTime;
  let clock = at;
  const now = () => new Date(clock);
  const runtime = createEmployerPostingRuntime({ clock: () => clock });
  return {
    runtime,
    advance: (ms) => {
      clock += ms;
      virtualTime = Math.max(virtualTime, clock);
    },
    count: async (company, fetcher, settings = config(), db = env.DB) => {
      const service = runtime.service(settings, db, fetcher, now);
      if (!service) return false;
      return service(
        await admitEmployerPosting(
          { e: "employer_posting_open", c: company },
          `2001:db8:6789::${(++address).toString(16)}`,
          now(),
        ),
      );
    },
  };
}

function freshOptions(url, options) {
  assert.equal(url, URL);
  assert.deepEqual(Object.keys(options).sort(), [
    "cache",
    "credentials",
    "method",
    "redirect",
    "signal",
  ]);
  assert.equal(options.method, "GET");
  assert.equal(options.cache, "no-store");
  assert.equal(options.redirect, "error");
  assert.equal(options.credentials, "omit");
  assert.ok(options.signal instanceof AbortSignal);
  // The actual workerd Request implementation accepts this cache mode under existing compatibility.
  assert.doesNotThrow(() => new Request(url, { cache: options.cache }));
}

it("requires explicit enabled published mode and rejects mixed or untrusted descriptors", () => {
  assert.equal(employerCatalogDescriptor({}), null);
  assert.equal(
    employerCatalogDescriptor({ ...config(), EMPLOYER_POSTING_COUNTS_ENABLED: true }),
    null,
  );
  assert.deepEqual(employerCatalogDescriptor(config()), published);
  for (const value of [
    null,
    [],
    { url: URL },
    { ...published, mode: "latest" },
    { ...published, url: URL + "?v=other" },
    { ...published, url: "https://other.test/" },
    { ...published, version: "a".repeat(40) },
    { ...published, sha256: "0".repeat(64) },
    { ...published, extra: true },
    { ...published, mode: true },
  ])
    assert.equal(employerCatalogDescriptor(config(value)), null);
});

it("refreshes A to B and removes A at the hard lifetime without changing configuration", async () => {
  const f = await fixture(),
    settings = config();
  let body = '["alpha"]',
    loads = 0;
  const load = async (url, options) => {
    freshOptions(url, options);
    loads++;
    return reply(url, body);
  };
  assert.equal(await f.count("alpha", load, settings), true);
  body = '["beta"]';
  f.advance(299999);
  assert.equal(await f.count("alpha", load, settings), true);
  assert.equal(await f.count("beta", load, settings), false);
  assert.equal(loads, 1);
  f.advance(1);
  assert.equal(await f.count("alpha", load, settings), false);
  assert.equal(await f.count("beta", load, settings), true);
  assert.equal(loads, 2);
  assert.equal(settings.EMPLOYER_POSTING_CATALOG, JSON.stringify(published));
});

it("does not use expired membership after a failed refresh and recovers after bounded retry delay", async () => {
  const f = await fixture();
  assert.equal(await f.count("alpha", async (url) => reply(url, '["alpha"]')), true);
  f.advance(300000);
  let loads = 0;
  const failed = async () => {
    loads++;
    throw new Error("synthetic unavailable");
  };
  assert.equal(await f.count("alpha", failed), false);
  assert.equal(await f.count("alpha", failed), false);
  assert.equal(loads, 1);
  f.advance(5000);
  assert.equal(await f.count("beta", async (url) => reply(url, '["beta"]')), true);
  assert.equal(await f.count("alpha", failed), false);
  assert.equal(loads, 1);
});

it("retains canonical parser, streamed byte, response URL and status boundaries", async () => {
  for (const kind of [
    "duplicate",
    "empty",
    "key",
    "object",
    "utf8",
    "oversize",
    "redirect",
    "partial",
    "length",
  ]) {
    const f = await fixture();
    const load = async (url) => {
      if (kind === "redirect") return reply("https://other.test/", '["alpha"]');
      if (kind === "partial") return reply(url, '["alpha"]', { status: 206 });
      if (kind === "length")
        return reply(url, '["alpha"]', { headers: { "Content-Length": "262145" } });
      const bodies = {
        duplicate: '["alpha","alpha"]',
        empty: "[]",
        key: '[" alpha"]',
        object: "{}",
        utf8: new Uint8Array([255]),
        oversize: new Uint8Array(262145),
      };
      return reply(url, bodies[kind]);
    };
    assert.equal(await f.count("alpha", load), false, kind);
    assert.equal(
      (await env.DB.prepare("SELECT n FROM employer_posting_day_caps").first()).n,
      0,
      kind,
    );
  }
});

it("rejects late fetch and body completion even before a real timeout callback runs", async () => {
  for (const phase of ["fetch", "body"]) {
    const f = await fixture();
    let cancelled = false;
    assert.equal(
      await f.count("alpha", async (url) => {
        if (phase === "fetch") f.advance(5000);
        return reply(
          url,
          new ReadableStream({
            pull(controller) {
              if (phase === "body") f.advance(5000);
              controller.enqueue(new TextEncoder().encode('["alpha"]'));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      }),
      false,
    );
    assert.equal(cancelled, true);
  }
});

it("competing calls do not share or cancel the refresh owner's I/O", async () => {
  const f = await fixture();
  let release, signal;
  const owner = f.count("alpha", (url, options) => {
    freshOptions(url, options);
    signal = options.signal;
    return new Promise((resolve) => {
      release = () => resolve(reply(url, '["alpha"]'));
    });
  });
  for (let i = 0; !release && i < 100; i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(release);
  assert.equal(
    await f.count("alpha", () => {
      throw new Error("competitor must not load");
    }),
    false,
  );
  assert.equal(signal.aborted, false);
  release();
  assert.equal(await owner, true);
});

it("a late owner cannot overwrite a recovered newer catalog", async () => {
  const f = await fixture();
  let release, signal;
  const old = f.count("alpha", (url, options) => {
    signal = options.signal;
    return new Promise((resolve) => {
      release = () => resolve(reply(url, '["alpha"]'));
    });
  });
  for (let i = 0; !release && i < 100; i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(release);
  f.advance(5000);
  assert.equal(
    await f.count("alpha", () => {
      throw new Error("no competing load");
    }),
    false,
  );
  assert.equal(signal.aborted, false, "competitor does not abort the old request");
  f.advance(5000);
  assert.equal(await f.count("beta", async (url) => reply(url, '["beta"]')), true);
  release();
  assert.equal(await old, false);
  assert.equal(
    await f.count("alpha", () => {
      throw new Error("cached beta");
    }),
    false,
  );
});

it("keeps exact pin mode compatible and invalidates membership across mode switches", async () => {
  const f = await fixture(),
    text = '["alpha"]';
  const sha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (n) => n.toString(16).padStart(2, "0"),
  ).join("");
  const pinned = { url: URL, version: "a".repeat(40), sha256 };
  assert.deepEqual(employerCatalogDescriptor(config(pinned)), pinned);
  const load = async (url, options) => {
    assert.equal(url, URL + "?v=" + pinned.version);
    assert.deepEqual(Object.keys(options).sort(), ["credentials", "redirect", "signal"]);
    return reply(url, text);
  };
  assert.equal(await f.count("alpha", load, config(pinned)), true);
  assert.equal(
    await f.count("alpha", async (url, options) => {
      freshOptions(url, options);
      return reply(url, '["beta"]');
    }),
    false,
  );
  assert.equal(await f.count("beta", load, config(pinned)), false);
  assert.equal(await f.count("alpha", load, config({ ...pinned, sha256: "0".repeat(64) })), false);
});

it("turning off the runtime invalidates an outstanding published loader", async () => {
  const f = await fixture();
  let release;
  const pending = f.count(
    "alpha",
    (url) =>
      new Promise((resolve) => {
        release = () => resolve(reply(url, '["alpha"]'));
      }),
  );
  for (let i = 0; !release && i < 100; i++) await new Promise((r) => setTimeout(r, 1));
  assert.ok(release);
  assert.equal(
    f.runtime.service({}, env.DB, () => {
      throw new Error("off");
    }),
    null,
  );
  release();
  assert.equal(await pending, false);
});
