import assert from "node:assert/strict";
import { deliverFollowSnapshotDigest } from "../src/follow-digest-delivery.js";
import { prepareLeasedFollowDigest } from "../src/follow-digest-prepare.js";
import { matchFollowSnapshot, matchFollowSnapshotWithRelated } from "../src/follow-matching.js";
import { enqueueFollowSnapshot } from "../src/follow-enqueue.js";
import { requestFollow, mintFollowToken, confirmFollow } from "../src/follows.js";

const catalog = {
  companies: new Set(["alpha", "beta"]),
  fields: new Set(["swe", "biology"]),
  states: new Set(["MA"]),
};
const limits = {
  maxBytes: 20000,
  maxRoles: 10,
  maxFollows: 10,
  maxMatches: 10,
  maxResultBytes: 20000,
  maxTextBytes: 300,
  maxWindowMs: 4 * 86400000,
};
const related = {
  maxRoles: 10,
  maxDirect: 10,
  maxPairs: 100,
  maxInputBytes: 20000,
  maxResultBytes: 20000,
};
async function fixture(db, empty = false) {
  const now = new Date(),
    confirmed = new Date(+now - 86400000);
  const roles = [1, 2, 3, 4].map((n) => ({
    id: String(n).repeat(16),
    company_key: n <= 2 ? "alpha" : "beta",
    company_name: "Fixture",
    title: `Role ${n}`,
    location: "MA",
    status: "open",
    field_tags: [n === 2 || n === 3 || (empty && n === 4) ? "biology" : "swe"],
    states: ["MA"],
    first_seen: new Date(+now - 3600000).toISOString(),
    apply_url: n === 2 ? "https://jobs.example.test/1#duplicate" : `https://jobs.example.test/${n}`,
  }));
  const text = JSON.stringify({
    version: 1,
    complete: true,
    generated_at: now.toISOString(),
    covers_after: new Date(+confirmed - 3600000).toISOString(),
    roles,
  });
  const bytes = new TextEncoder().encode(text);
  const sub = await requestFollow(
    db,
    "fixture@example.test",
    { kind: "company", company: "alpha" },
    catalog,
    confirmed,
  );
  await confirmFollow(
    db,
    await mintFollowToken(db, sub.subscriberId, "confirm", { scopeKey: sub.scopeKey }, confirmed),
    confirmed,
  );
  const job = await enqueueFollowSnapshot(
    db,
    sub.subscriberId,
    bytes,
    {
      catalog,
      limits,
      upperBound: now.toISOString(),
      maxProgressBytes: 4000,
      maxPendingBytes: 4000,
    },
    now,
  );
  assert.equal(job.status, "queued");
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(7),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  let at = +now,
    reads = 0;
  const sent = [];
  const options = {
    db,
    jobId: job.id,
    key,
    cap: 3,
    clock: () => new Date(at),
    catalog,
    limits,
    loadSnapshot: async () => {
      reads++;
      return bytes;
    },
    present: async () => ({
      from: "Fixture <sender@example.test>",
      postalAddress: "1 Fixture Lane",
      origins: ["https://internscout.org", "https://site.example.test"],
      similar: [{ ...roles[2], title: "Caller override" }],
      links: {
        management: "https://site.example.test/manage/fixture",
        unsubscribe: "https://site.example.test/unsubscribe/fixture",
        matchingPage: "https://internscout.org/",
        publicShare: "https://internscout.org/",
      },
    }),
    transport: async (message) => {
      sent.push(message);
    },
  };
  return {
    options,
    sent,
    bytes,
    text,
    reads: () => reads,
    roles,
    now,
    confirmed,
    sub,
    advance: () => {
      at += 2 * 86400000;
    },
    attempts: () => db.prepare("SELECT SUM(attempts) AS n FROM follow_send_budget").first("n"),
  };
}

export async function verifiedSelectionAndOwnedCapabilityBranch(db) {
  const f = await fixture(db);
  const chosen = { ...related };
  const originalPresent = f.options.present;
  f.options.present = async () =>
    Object.defineProperty(await originalPresent(), "similar", {
      enumerable: true,
      get() {
        assert.fail("must not inspect caller similar");
      },
    });
  const originalLoad = f.options.loadSnapshot;
  f.options.loadSnapshot = async (pin) => {
    chosen.maxRoles = 0;
    return originalLoad(pin);
  };
  const parse = JSON.parse;
  let parses = 0;
  JSON.parse = (...args) => {
    if (args[0] === f.text) parses++;
    return parse(...args);
  };
  try {
    assert.deepEqual(
      await deliverFollowSnapshotDigest({
        ...f.options,
        relatedLimits: chosen,
        buildLinks: ({ management, unsubscribe }) => ({
          management: `https://internscout.org/follows/manage.html#token=${management}`,
          unsubscribe: `https://internscout.org/follows/unsubscribe?token=${unsubscribe}`,
        }),
      }),
      { status: "accepted" },
    );
  } finally {
    JSON.parse = parse;
  }
  assert.equal(parses, 1);
  assert.equal(f.reads(), 1);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /One similar role:\nFixture: Role 4/);
  assert.doesNotMatch(f.sent[0].text, /Role 2|Role 3|Caller override/);
}

export async function verifiedSelectionOrdinaryBranch(db) {
  const f = await fixture(db);
  const originalPresent = f.options.present;
  f.options.present = async () =>
    Object.defineProperty(await originalPresent(), "similar", {
      enumerable: true,
      get() {
        assert.fail("must not inspect caller similar");
      },
    });
  assert.deepEqual(await deliverFollowSnapshotDigest({ ...f.options, relatedLimits: related }), {
    status: "accepted",
  });
  assert.match(f.sent[0].text, /One similar role:\nFixture: Role 4/);
  assert.doesNotMatch(f.sent[0].text, /Caller override/);
}

export async function validEmptyStillDeliversDirect(db) {
  const f = await fixture(db, true);
  assert.deepEqual(await deliverFollowSnapshotDigest({ ...f.options, relatedLimits: related }), {
    status: "accepted",
  });
  assert.match(f.sent[0].text, /Fixture: Role 1/);
  assert.doesNotMatch(f.sent[0].text, /similar role|Caller override/);
}

export async function omittedOptionPreservesMatchingBudgetAndPresentation(db) {
  const f = await fixture(db);
  const follows = [
    { scope_key: f.sub.scopeKey, confirmed_at: f.confirmed.toISOString(), watermark: null },
  ];
  const options = { catalog, limits, upperBound: f.now.toISOString() };
  const legacy = matchFollowSnapshot(f.bytes, follows, options);
  const selected = matchFollowSnapshotWithRelated(f.bytes, follows, options, related);
  const { similar, ...same } = selected;
  assert.deepEqual(same, legacy);
  assert.deepEqual(
    similar.map((r) => r.id),
    ["4".repeat(16)],
  );
  const exact = new TextEncoder().encode(JSON.stringify(legacy)).length;
  assert.deepEqual(
    matchFollowSnapshot(f.bytes, follows, {
      ...options,
      limits: { ...limits, maxResultBytes: exact },
    }),
    legacy,
  );
  assert.equal(
    matchFollowSnapshot(f.bytes, follows, {
      ...options,
      limits: { ...limits, maxResultBytes: exact - 1 },
    }).status,
    "invalid",
  );
  assert.deepEqual(await deliverFollowSnapshotDigest(f.options), { status: "accepted" });
  assert.match(f.sent[0].text, /Caller override/);
}

export async function undersizedSelectionFailsBeforeClaim(db) {
  const f = await fixture(db);
  assert.deepEqual(
    await deliverFollowSnapshotDigest({
      ...f.options,
      relatedLimits: { ...related, maxPairs: 1 },
    }),
    { status: "unavailable" },
  );
  assert.equal(f.sent.length, 0);
  assert.equal(await f.attempts(), null);
}

export async function accessorBoundsFailClosedWithoutIO(db) {
  const f = await fixture(db);
  const bounds = Object.defineProperty({ ...related }, "maxDirect", {
    get() {
      assert.fail("must not invoke bound accessor");
    },
  });
  const noDB = {
    prepare() {
      assert.fail("must reject before DB");
    },
  };
  assert.deepEqual(
    await deliverFollowSnapshotDigest({ ...f.options, db: noDB, relatedLimits: bounds }),
    { status: "unavailable" },
  );
  assert.deepEqual(
    await prepareLeasedFollowDigest(noDB, f.options.jobId, f.options.jobId, {
      ...f.options,
      relatedLimits: bounds,
    }),
    { status: "unavailable" },
  );
  assert.equal(f.reads(), 0);
  assert.equal(await f.attempts(), null);
}

export async function alteredArchiveFailsBeforeClaim(db) {
  const f = await fixture(db);
  assert.deepEqual(
    await deliverFollowSnapshotDigest({
      ...f.options,
      relatedLimits: related,
      loadSnapshot: async () => new TextEncoder().encode(f.text + " "),
    }),
    { status: "unavailable" },
  );
  assert.equal(f.sent.length, 0);
  assert.equal(await f.attempts(), null);
}

export async function expiredLeaseAfterLoadFailsBeforeClaim(db) {
  const f = await fixture(db);
  assert.deepEqual(
    await deliverFollowSnapshotDigest({
      ...f.options,
      relatedLimits: related,
      loadSnapshot: async () => {
        f.advance();
        return f.bytes;
      },
    }),
    { status: "unavailable" },
  );
  assert.equal(f.sent.length, 0);
  assert.equal(await f.attempts(), null);
}
