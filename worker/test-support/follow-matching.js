import assert from "node:assert/strict";
import { canonicalFollow } from "../src/follows.js";
import { matchFollowSnapshot } from "../src/follow-matching.js";

const catalog = {
  companies: new Set(["acme", "labs", "empty"]),
  fields: new Set(["swe", "biology", "finance"]),
  states: new Set(["CA", "NY", "TX", "REMOTE"]),
};
const upperBound = "2026-11-12T00:00:00.000Z";
const limits = {
  maxBytes: 20000,
  maxRoles: 100,
  maxFollows: 20,
  maxMatches: 100,
  maxResultBytes: 20000,
  maxTextBytes: 200,
  maxWindowMs: 3 * 86400000,
};
const role = (n, company_key = "labs", field_tags = ["swe"], states = ["CA"]) => ({
  id: n.toString(16).padStart(16, "0"),
  company_key,
  field_tags,
  states,
  first_seen: "2026-11-11T12:00:00.000Z",
  status: "open",
  company_name: "Fixture employer",
  title: "Fixture internship",
  location: "Fixture city",
  apply_url: `https://jobs.example.test/${n}`,
});
const fixture = () => ({
  version: 1,
  complete: true,
  generated_at: upperBound,
  covers_after: "2026-11-10T00:00:00.000Z",
  roles: [
    role(1, "acme"),
    role(2, "labs", ["biology"], ["NY"]),
    role(3, "labs", ["swe"], ["TX"]),
    role(4, "labs", ["finance"]),
    role(5, "acme", ["finance"], ["TX"]),
    { ...role(6, "acme"), first_seen: "2026-11-10T12:00:00.000Z" },
  ],
});
const follow = (scope = { kind: "company", company: "acme" }, patch = {}) => ({
  scope_key: canonicalFollow(scope, catalog),
  confirmed_at: "2026-11-10T12:00:00.000Z",
  watermark: null,
  ...patch,
});
const run = (data = fixture(), follows = [follow()], extra = {}) =>
  matchFollowSnapshot(new TextEncoder().encode(JSON.stringify(data)), follows, {
    catalog,
    limits,
    upperBound,
    ...extra,
  });
const ids = (result) => result.roles.map((row) => Number.parseInt(row.id, 16));
const rejected = (result) => {
  assert.equal(result.status, "invalid");
  assert.deepEqual(Object.keys(result).sort(), ["reason", "status"]);
};

export function followMatchingScopes() {
  const search = follow({ kind: "search", fields: ["swe", "biology"], states: ["NY", "CA"] });
  const follows = [follow(), search],
    data = fixture();
  const before = structuredClone({ follows, data });
  follows.forEach(Object.freeze);
  Object.freeze(follows);
  const result = run(data, follows);
  assert.deepEqual(ids(result), [1, 2, 5]);
  assert.deepEqual(
    result.refs.map((r) => r.roles.length),
    [2, 2],
  );
  assert.deepEqual(
    result.advances.map((r) => r.to),
    [upperBound, upperBound],
  );
  assert.equal(result.advances[0].confirmedAt, follows[0].confirmed_at);
  assert.deepEqual({ follows, data }, before);
  assert.deepEqual(ids(run(data, [follow({ kind: "company", company: "labs" })])), [2, 3, 4]);
  assert.deepEqual(
    ids(run(data, [follow({ kind: "search", fields: [], states: ["CA", "NY"] })])),
    [1, 2, 4],
  );
  assert.deepEqual(
    ids(run(data, [follow({ kind: "search", fields: ["biology"], states: [] })])),
    [2],
  );
  const empty = run(data, [follow({ kind: "company", company: "empty" })]);
  assert.deepEqual(empty.roles, []);
  assert.deepEqual(empty.refs, []);
  assert.equal(empty.advances[0].to, upperBound);
  const pending = run(data, [follow(undefined, { confirmed_at: null })]);
  assert.deepEqual(pending.roles, []);
  assert.deepEqual(pending.advances, []);
  rejected(run(data, [follow(), follow()]));
  rejected(
    run(data, [{ ...follow(), scope_key: '{"kind":"search","fields":[],"states":["REMOTE"]}' }]),
  );
}

export function followMatchingWatermarks() {
  const data = fixture();
  data.roles[0].first_seen = upperBound;
  assert.deepEqual(ids(run(data)), [1, 5]); // inclusive upper; exact confirmation excluded
  const repeated = run(data, [follow(undefined, { watermark: upperBound })]);
  assert.deepEqual(repeated.roles, []);
  assert.equal(repeated.advances[0].to, upperBound);
  assert.deepEqual(
    ids(run(data, [follow(undefined, { watermark: "2026-11-09T00:00:00.000Z" })])),
    [1, 5],
  );
  rejected(run(data, [follow(undefined, { confirmed_at: "2026-11-09T00:00:00.000Z" })]));
  assert.equal(
    run(data, [
      follow(undefined, {
        confirmed_at: "2026-11-09T00:00:00.000Z",
        watermark: "2026-11-11T00:00:00.000Z",
      }),
    ]).status,
    "matched",
  );
  for (const patch of [
    { confirmed_at: "2026-11-13T00:00:00.000Z" },
    { watermark: "2026-11-13T00:00:00.000Z" },
    { watermark: "2026-02-30T00:00:00.000Z" },
    { confirmed_at: null, watermark: upperBound },
  ])
    rejected(run(data, [follow(undefined, patch)]));
  for (const stamp of [
    "2026-11-11",
    "2026-11-11T12:00:00",
    "2026-11-11T12:00:00.000+00:00",
    "2026-02-30T12:00:00.000Z",
    "2026-11-12T00:00:00.001Z",
    data.covers_after,
  ]) {
    const bad = fixture();
    bad.roles[0].first_seen = stamp;
    rejected(run(bad));
  }
  const leap = {
    version: 1,
    complete: true,
    generated_at: "2028-03-01T00:00:00.000Z",
    covers_after: "2028-02-28T00:00:00.000Z",
    roles: [{ ...role(1, "acme"), first_seen: "2028-02-29T00:00:00.000Z" }],
  };
  assert.deepEqual(
    ids(
      run(leap, [follow(undefined, { confirmed_at: leap.covers_after })], {
        upperBound: leap.generated_at,
      }),
    ),
    [1],
  );
  const noRoles = { ...fixture(), roles: [] };
  assert.equal(run(noRoles).advances[0].to, upperBound);
}

export function followMatchingValidation() {
  for (const patch of [
    { version: 2 },
    { complete: false },
    { generated_at: "2026-11-11T00:00:00.000Z" },
    { covers_after: upperBound },
    { covers_after: "2026-11-01T00:00:00.000Z" },
    { extra: 1 },
    { roles: null },
  ])
    rejected(run({ ...fixture(), ...patch }));
  for (const patch of [
    { id: "123" },
    { id: "A".repeat(16) },
    { company_key: "Acme" },
    { status: "closed" },
    { field_tags: ["unknown"] },
    { states: ["XX"] },
    { states: ["CA", "CA"] },
    { apply_url: "javascript:alert(1)" },
    { apply_url: "https://user:pass@jobs.example.test/" },
    { apply_url: "https://@jobs.example.test/" },
    { apply_url: 'https://jobs.example.test/"bad' },
    { apply_url: "https://jobs.example.test/<bad>" },
    { title: "Line\nbreak" },
    { title: "\ud800" },
    { unknown: true },
  ]) {
    const bad = fixture();
    bad.roles[0] = { ...bad.roles[0], ...patch };
    rejected(run(bad));
  }
  const duplicate = fixture();
  duplicate.roles.push({ ...duplicate.roles[0] });
  rejected(run(duplicate));
  const conflicting = fixture();
  conflicting.roles[1].id = conflicting.roles[0].id;
  rejected(run(conflicting));
  for (const patch of [
    { maxBytes: 1 },
    { maxRoles: 1 },
    { maxMatches: 1 },
    { maxResultBytes: 1 },
    { maxTextBytes: 1 },
    { maxWindowMs: 1 },
    { maxFollows: 0 },
    { maxBytes: Infinity },
  ])
    rejected(run(fixture(), [follow()], { limits: { ...limits, ...patch } }));
  rejected(
    run(fixture(), [follow(), follow({ kind: "company", company: "labs" })], {
      limits: { ...limits, maxFollows: 1 },
    }),
  );
  const unicode = fixture();
  unicode.roles[0].company_name = "éééé";
  rejected(
    run(unicode, [follow()], { limits: { ...limits, maxBytes: JSON.stringify(unicode).length } }),
  );
  rejected(matchFollowSnapshot(new TextEncoder().encode("{"), [], { catalog, limits, upperBound }));
  rejected(matchFollowSnapshot(new Uint8Array([0xff]), [], { catalog, limits, upperBound }));
  rejected(matchFollowSnapshot(JSON.stringify(fixture()), [], { catalog, limits, upperBound }));
  rejected(matchFollowSnapshot(new Uint8Array(), []));
  for (const apply_url of [
    "https://jobs.example.test/" + "x".repeat(2000),
    "https://jobs.example.test/" + "é".repeat(400),
  ])
    rejected(
      run({ ...fixture(), roles: [{ ...role(1), apply_url }] }, [follow()], {
        limits: { ...limits, maxTextBytes: 10000 },
      }),
    );
  rejected(
    run({ ...fixture(), roles: [{ ...role(1), company_name: "x".repeat(201) }] }, [follow()], {
      limits: { ...limits, maxTextBytes: 10000 },
    }),
  );
  rejected(
    run(fixture(), [{ ...follow(), scope_key: '{"kind":"search","fields":[],"states":[]}' }]),
  );
  rejected(run(fixture(), [{ ...follow(), email: "synthetic@example.test" }]));
}
