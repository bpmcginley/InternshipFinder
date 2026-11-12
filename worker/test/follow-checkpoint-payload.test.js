import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createFollowCheckpointPayloadCodec } from "../src/follow-checkpoint-payload.js";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/follow-checkpoint-payload.json", import.meta.url)),
);
const bounds = {
  maxCheckpointBytes: 12000,
  maxPayloadBytes: 10000,
  maxHeaderBytes: 2000,
  maxRows: 5,
};
const codec = createFollowCheckpointPayloadCodec(bounds);
const encode = (text) => new TextEncoder().encode(text);
const text = (bytes) => new TextDecoder().decode(bytes);
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sorted(value[key])]),
    );
  return value;
}
const canonical = (value) => JSON.stringify(sorted(value));

test("checkpoint payload reproduces exact Python pending/accepted golden bytes and digests", async () => {
  for (const row of fixture.cases) {
    const parts = await codec.split(encode(row.checkpoint), row.phase);
    assert.equal(text(parts.payload), row.payload);
    assert.equal(text(parts.header), row.header);
    assert.equal(parts.payloadSha256, row.payload_sha256);
    assert.equal(parts.checkpointSha256, row.sha256);
    const restored = await codec.reassemble(parts.payload, parts.header, row.phase, row.sha256);
    assert.equal(text(restored.bytes), row.checkpoint);
    assert.equal(restored.sha256, row.sha256);
    if (row.closed_id)
      assert.ok(JSON.parse(text(parts.payload)).rows.some((v) => v[0] === row.closed_id));
  }
  assert.equal(
    fixture.cases[0].payload,
    fixture.cases[1].payload,
    "promotion needs no payload rewrite",
  );
});

test("checkpoint payload bounds are explicit and inclusive for every representation", async () => {
  const row = fixture.cases[0];
  const exact = {
    maxCheckpointBytes: encode(row.checkpoint).length,
    maxPayloadBytes: encode(row.payload).length,
    maxHeaderBytes: encode(row.header).length,
    maxRows: 2,
  };
  const bounded = createFollowCheckpointPayloadCodec(exact);
  const parts = await bounded.split(encode(row.checkpoint), row.phase);
  await bounded.reassemble(parts.payload, parts.header, row.phase, row.sha256);
  for (const key of Object.keys(exact)) {
    const small = createFollowCheckpointPayloadCodec({ ...exact, [key]: exact[key] - 1 });
    await assert.rejects(small.split(encode(row.checkpoint), row.phase), /Invalid checkpoint/);
    await assert.rejects(
      small.reassemble(parts.payload, parts.header, row.phase, row.sha256),
      /Invalid checkpoint/,
    );
    assert.throws(() => createFollowCheckpointPayloadCodec({ ...exact, [key]: 0 }));
  }
});

test("checkpoint payload rejects malformed shape, ordering, identity and timestamp spellings", async () => {
  const row = fixture.cases[0];
  const mutate = [
    (v) => v.rows.reverse(),
    (v) => v.rows.push(v.rows[0]),
    (v) => v.rows[0].push("extra"),
    (v) => (v.rows[0][0] += "\n"),
    (v) => (v.rows[0][2] = "unknown"),
    (v) => (v.rows[0][1] = "2026-02-30T12:00:00"),
    (v) => (v.rows[0][3] = "2026-11-11T18:00:00Z"),
    (v) => (v.rows[0][1] += "\n"),
    (v) => (v.rows = {}),
    (v) => (v.version = true),
    (v) => (v.extra = 1),
    (v) => delete v.index_sha256,
    (v) => (v.index_sha256 += "\n"),
    (v) => (v.shard_sha256 = {}),
    (v) => (v.shard_sha256 = { bad: "a".repeat(64) }),
    (v) => (v.covers_after = "2026-11-11T17:00:00.000001Z"),
    (v) => (v.prepared_at = "2026-11-11T16:00:00.000000Z"),
    (v) => (v.predecessor.commit = "a".repeat(64)),
    (v) => (v.predecessor.extra = null),
    (v) => (v.predecessor.checkpoint_sha256 = false),
  ];
  for (const change of mutate) {
    const value = JSON.parse(row.checkpoint);
    change(value);
    await assert.rejects(codec.split(encode(canonical(value)), "pending"), /Invalid checkpoint/);
  }
  for (const raw of [
    row.checkpoint + " ",
    "\ufeff" + row.checkpoint,
    row.checkpoint.replace('"version":1', '"version":1,"version":1'),
    row.checkpoint.replace('"version"', '"vers\\u0069on"'),
    "{not-json}",
  ]) {
    await assert.rejects(codec.split(encode(raw), "pending"), /Invalid checkpoint/);
  }
  await assert.rejects(codec.split(new Uint8Array([255]), "pending"), /Invalid checkpoint/);
});

test("checkpoint timestamp rules apply to both phases and directions", async (t) => {
  for (const row of fixture.cases.slice(0, 2)) {
    const phaseTime = row.phase === "pending" ? "prepared_at" : "accepted_at";
    for (const [name, change] of [
      [
        "unknown first-seen offset",
        (payload) => (payload.rows[0][1] = "2026-11-11T12:00:00-00:00"),
      ],
      [
        "phase time in the coverage millisecond",
        (payload, header) => (header[phaseTime] = payload.covers_after.slice(0, -4) + "001Z"),
      ],
    ]) {
      const payload = JSON.parse(row.payload);
      const header = JSON.parse(row.header);
      change(payload, header);
      const checkpoint = encode(canonical({ ...payload, ...header }));
      const sha256 = createHash("sha256").update(checkpoint).digest("hex");
      await t.test(`split ${row.phase} rejects ${name}`, async () => {
        await assert.rejects(codec.split(checkpoint, row.phase), /Invalid checkpoint/);
      });
      await t.test(`reassemble ${row.phase} rejects ${name}`, async () => {
        await assert.rejects(
          codec.reassemble(
            encode(canonical(payload)),
            encode(canonical(header)),
            row.phase,
            sha256,
          ),
          /Invalid checkpoint/,
        );
      });
    }
  }
});

test("checkpoint reassembly requires exact generation digest and correct phase header", async () => {
  const [pending, accepted] = fixture.cases;
  const parts = await codec.split(encode(pending.checkpoint), "pending");
  for (const [header, phase, digest] of [
    [parts.header, "pending", "0".repeat(64)],
    [parts.header, "pending", undefined],
    [parts.header, "accepted", pending.sha256],
    [parts.header, "__proto__", pending.sha256],
    [encode(accepted.header), "accepted", pending.sha256],
    [encode(text(parts.header) + " "), "pending", pending.sha256],
  ])
    await assert.rejects(
      codec.reassemble(parts.payload, header, phase, digest),
      /Invalid checkpoint/,
    );
});

test("checkpoint phases reject coercible values without invoking conversion hooks", async () => {
  for (const row of fixture.cases.slice(0, 2)) {
    let conversions = 0;
    const coercible = {
      toString() {
        conversions++;
        return row.phase;
      },
    };
    const symbolic = {
      [Symbol.toPrimitive]() {
        conversions++;
        return row.phase;
      },
    };
    for (const phase of [
      [row.phase],
      new String(row.phase),
      coercible,
      symbolic,
      null,
      undefined,
      1,
    ]) {
      await assert.rejects(codec.split(encode(row.checkpoint), phase), /Invalid checkpoint/);
      await assert.rejects(
        codec.reassemble(encode(row.payload), encode(row.header), phase, row.sha256),
        /Invalid checkpoint/,
      );
    }
    assert.equal(conversions, 0);
  }
});

test("checkpoint codec copies Buffer inputs before digest awaits", async () => {
  const row = fixture.cases[0],
    input = Buffer.from(row.checkpoint);
  const pending = codec.split(input, row.phase);
  input.fill(0);
  const parts = await pending;
  assert.equal(parts.checkpointSha256, row.sha256);
  const payload = Buffer.from(parts.payload),
    header = Buffer.from(parts.header);
  const assembling = codec.reassemble(payload, header, row.phase, row.sha256);
  payload.fill(0);
  header.fill(0);
  assert.equal(text((await assembling).bytes), row.checkpoint);
});
