import assert from "node:assert/strict";
import { selectFollowRelatedRoles } from "../src/follow-related-roles.js";
import { renderFollowMail } from "../src/follow-mail.js";

const limits = {
  maxRoles: 100,
  maxDirect: 20,
  maxPairs: 2000,
  maxInputBytes: 100000,
  maxResultBytes: 10000,
};
const role = (n, extra = {}) => ({
  id: n.toString(16).padStart(16, "0"),
  company_key: "fixture",
  company_name: "Fixture Labs",
  title: "Intern",
  location: "New York",
  apply_url: `https://jobs.example/role/${n}`,
  status: "open",
  field_tags: ["software"],
  states: ["NY"],
  first_seen: "2026-11-13T00:00:00.000Z",
  ...extra,
});
const ids = (result) => {
  assert.equal(result.status, "selected");
  return result.similar.map((r) => r.id);
};
const select = (rows, seeds = [rows[0]], bounds = limits) =>
  selectFollowRelatedRoles(rows, seeds, bounds);

export function relatedRoleCases(test) {
  test("no direct matches, empty snapshot and no eligible relationship produce no suggestions", () => {
    assert.deepEqual(ids(select([], [])), []);
    assert.deepEqual(ids(select([role(1)], [])), []);
    assert.deepEqual(
      ids(select([role(1), role(2, { company_key: "else", field_tags: ["art"] })])),
      [],
    );
  });
  test("same employer outranks more fields and recency; cap is two", () => {
    const rows = [
      role(1, { field_tags: ["software", "math"] }),
      role(2, { company_key: "else", field_tags: ["software", "math"] }),
      role(3, { field_tags: [], first_seen: "2026-11-12T00:00:00.000Z" }),
      role(4),
    ];
    assert.deepEqual(ids(select(rows)), [rows[3].id, rows[2].id]);
  });
  test("shared fields then states then first_seen then ASCII id resolve ties", () => {
    const seed = role(1, { field_tags: ["a", "b"], states: ["NY", "MA"] });
    const rows = [
      seed,
      role(5, { field_tags: ["a", "b"], states: ["NY"] }),
      role(4, { field_tags: ["a", "b"], states: ["NY", "MA"] }),
      role(3, { field_tags: ["a", "b"], states: ["NY", "MA"] }),
      role(2, { field_tags: ["a"], states: ["NY", "MA"] }),
    ];
    assert.deepEqual(ids(select(rows)), [rows[3].id, rows[2].id]);
    rows[1].first_seen = "2026-11-14T00:00:00.000Z";
    assert.deepEqual(ids(select(rows)), [rows[3].id, rows[2].id]);
    rows[2].first_seen = "2026-11-14T00:00:00.000Z";
    assert.deepEqual(ids(select(rows)), [rows[2].id, rows[3].id]);
  });
  test("best single seed tuple prevents pooling unrelated field and employer scores", () => {
    const a = role(1, { field_tags: ["a"], states: ["NY"] });
    const b = role(2, { company_key: "other", field_tags: ["b", "c"], states: ["MA"] });
    const pooled = role(3, { field_tags: ["b", "c"], states: ["MA"] });
    const actual = role(4, { field_tags: ["a"], states: [] });
    assert.deepEqual(ids(select([a, b, pooled, actual], [a, b])), [actual.id, pooled.id]);
  });
  test("posting identity excludes fragment but preserves query and normalizes host/default port", () => {
    const seed = role(1, { apply_url: "https://JOBS.example:443/one?q=1#direct" });
    const duplicate = role(2, { apply_url: "https://jobs.example/one?q=1#other" });
    const distinct = role(3, { apply_url: "https://jobs.example/one?q=2" });
    const alternative = role(4, { apply_url: "https://jobs.example/one?q=2#x" });
    assert.deepEqual(ids(select([seed, duplicate, alternative, distinct])), [distinct.id]);
  });
  test("best related duplicate replaces lower-ranked one and result is input-order independent", () => {
    const rows = [
      role(1),
      role(2, { apply_url: "https://jobs.example/same", company_key: "other" }),
      role(3),
      role(4, { apply_url: "https://jobs.example/same#x", first_seen: "2026-11-14T00:00:00.000Z" }),
      role(5),
    ];
    const expected = [rows[3].id, rows[2].id];
    assert.deepEqual(ids(select(rows)), expected);
    assert.deepEqual(ids(select([...rows].reverse(), [rows[0]])), expected);
  });
  test("requires actual deduplicated same-snapshot direct objects", () => {
    const a = role(1),
      b = role(2, { apply_url: a.apply_url + "#same" });
    for (const direct of [[{ ...a }], [role(8)], [a, a], [a, b]])
      assert.equal(select([a, b], direct).reason, "direct");
  });
  test("malformed, duplicate and closed role facts fail as a whole", () => {
    for (const extra of [
      { status: "closed" },
      { id: "not-an-id" },
      { first_seen: "yesterday" },
      { apply_url: "https://user@jobs.example/a" },
      { field_tags: ["a", "a"] },
      { title: "x".repeat(301) },
    ])
      assert.equal(select([role(1), role(2, extra)]).status, "invalid");
    assert.equal(select([role(1), role(1)]).status, "invalid");
  });
  test("explicit row, seed and pair bounds reject before reading any role", () => {
    const rows = [null, null];
    for (const bounds of [{ maxRoles: 1 }, { maxDirect: 1 }, { maxPairs: 3 }])
      assert.equal(select(rows, rows, { ...limits, ...bounds }).reason, "work_bound");
    for (const value of [undefined, {}, { ...limits, maxPairs: 0 }])
      assert.equal(selectFollowRelatedRoles([], [], value).reason, "limits");
  });
  test("exact UTF-8 input/result byte bounds fail without partial output", () => {
    const rows = [role(1), role(2, { title: "Stage à Montréal" })];
    const maxInputBytes = new TextEncoder().encode(JSON.stringify(rows)).length;
    const maxResultBytes = new TextEncoder().encode(JSON.stringify(select(rows))).length;
    assert.equal(
      select(rows, [rows[0]], { ...limits, maxInputBytes, maxResultBytes }).status,
      "selected",
    );
    assert.deepEqual(select(rows, [rows[0]], { ...limits, maxInputBytes: maxInputBytes - 1 }), {
      status: "invalid",
      reason: "input_bound",
    });
    assert.deepEqual(select(rows, [rows[0]], { ...limits, maxResultBytes: maxResultBytes - 1 }), {
      status: "invalid",
      reason: "result_bound",
    });
  });
  test("renderer retains exactly the selected suggestions without mutating source facts", () => {
    const rows = [role(1), role(2), role(3), role(4)];
    const original = JSON.stringify(rows);
    const similar = select(rows).similar;
    const message = renderFollowMail("digest", {
      from: "Fixture <sender@example.test>",
      to: "recipient@example.test",
      postalAddress: "Synthetic postal fixture",
      origins: ["https://example.test"],
      matches: [rows[0]],
      similar,
      links: {
        unsubscribe: "https://example.test/unsubscribe",
        management: "https://example.test/manage",
        matchingPage: "https://example.test/matches",
        publicShare: "https://example.test/share",
      },
    });
    assert.match(message.text, /Two similar roles:/);
    for (const row of [rows[0], ...similar])
      assert.equal(message.text.split(row.apply_url).length - 1, 1);
    assert.equal(message.text.includes(rows[3].apply_url), false);
    assert.equal(JSON.stringify(rows), original);
  });
}
