import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseFollowCatalog } from "../src/follow-catalog.js";
import { canonicalFollow } from "../src/follows.js";

const fixture = readFileSync(new URL("./fixtures/follow-catalog-python.json", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const original = JSON.parse(fixture);
const empty = () => ({ companies: new Set(), fields: new Set(), states: new Set() });
const options = (bytes = fixture) => ({
  maxBytes: fixture.length * 2,
  maxKeys: 100,
  sourceSha256: original.source_sha256,
  catalogSha256: digest(bytes),
  previousValid: empty(),
});
const changed = (change) => {
  const value = JSON.parse(fixture);
  change(value);
  return Buffer.from(JSON.stringify(value));
};
const reject = (bytes, overrides = {}) =>
  assert.rejects(parseFollowCatalog(bytes, { ...options(bytes), ...overrides }), {
    message: "Follow catalog unavailable",
  });

test("exact Python fixture yields separate current and retained sets without changing scope limits", async () => {
  const parsed = await parseFollowCatalog(fixture, options());
  assert.deepEqual([...parsed.aliases], original.aliases);
  assert.equal(parsed.aliases.get("The Booz Allen Hamilton Corporation"), "booz allen");
  assert.equal(parsed.signup.fields.size, 66);
  assert(!parsed.signup.companies.has("company without roles"));
  assert(parsed.valid.companies.has("company without roles"));
  assert.throws(() =>
    canonicalFollow({ kind: "company", company: "company without roles" }, parsed.signup),
  );
  assert.equal(
    canonicalFollow({ kind: "company", company: "company without roles" }, parsed.valid),
    '{"kind":"company","company":"company without roles"}',
  );
  canonicalFollow(
    { kind: "search", fields: [...parsed.signup.fields].slice(0, 64), states: [] },
    parsed.signup,
  );
  assert.throws(() =>
    canonicalFollow(
      { kind: "search", fields: [...parsed.signup.fields].slice(0, 65), states: [] },
      parsed.signup,
    ),
  );
  const again = await parseFollowCatalog(fixture, { ...options(), previousValid: parsed.valid });
  parsed.valid.companies.clear();
  assert(again.valid.companies.has("company without roles"));
});

test("bounds and expected source/payload digests are explicit and exact", async () => {
  await parseFollowCatalog(fixture, { ...options(), maxBytes: fixture.length });
  for (const override of [
    { maxBytes: fixture.length - 1 },
    { maxKeys: 65 },
    { sourceSha256: "a".repeat(64) },
    { catalogSha256: "b".repeat(64) },
    { previousValid: undefined },
  ])
    await reject(fixture, override);
  for (const name of ["maxBytes", "maxKeys"])
    for (const value of [0, -1, 1.5, true, "100", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      await reject(fixture, { [name]: value });
  await assert.rejects(parseFollowCatalog(fixture, undefined), /Follow catalog unavailable/);
  await assert.rejects(
    parseFollowCatalog(fixture.toString(), options()),
    /Follow catalog unavailable/,
  );
});

test("strict canonical bytes reject malformed UTF8, BOM, whitespace, duplicate fields and alternate spelling", async () => {
  for (const bytes of [
    Buffer.from([255]),
    Buffer.concat([Buffer.from([239, 187, 191]), fixture]),
    Buffer.concat([fixture, Buffer.from("\n")]),
    Buffer.from(fixture.toString().replace('"version":1', '"version":1,"version":1')),
    Buffer.from(fixture.toString().replace('"version":1', '"version":1.0')),
    Buffer.from(fixture.toString().replace('"version"', '"\\u0076ersion"')),
  ])
    await reject(bytes);
});

test("shape, ordering and vocabulary reject without partial sets", async () => {
  for (const change of [
    (v) => {
      v.version = 2;
    },
    (v) => {
      v.extra = true;
    },
    (v) => {
      v.signup = [];
    },
    (v) => {
      v.valid = null;
    },
    (v) => {
      v.signup.fields = [];
    },
    (v) => {
      v.signup.states = [];
    },
    (v) => {
      v.signup.fields.reverse();
    },
    (v) => {
      v.valid.fields.push(v.valid.fields.at(-1));
    },
    (v) => {
      v.signup.fields[0] = "unknown1";
    },
    (v) => {
      v.valid.states.push("REMOTE");
    },
    (v) => {
      v.valid.companies.push("\ud800");
    },
    (v) => {
      v.valid.companies.push("x".repeat(201));
    },
    (v) => {
      v.valid.companies = v.valid.companies.filter((x) => x !== "booz allen");
    },
  ]) {
    const bytes = changed(change);
    await reject(bytes);
  }
});

test("aliases must exactly cover current employers and obey bounded ordered public names", async () => {
  for (const change of [
    (v) => {
      v.aliases = [];
    },
    (v) => {
      v.aliases.reverse();
    },
    (v) => {
      v.aliases.push(v.aliases.at(-1));
    },
    (v) => {
      v.aliases[0][1] = "company without roles";
    },
    (v) => {
      v.aliases[0].push("extra");
    },
    (v) => {
      v.aliases[0][0] = "x".repeat(201);
    },
    (v) => {
      v.aliases[0][0] = " leading";
    },
    (v) => {
      v.aliases[0][0] = "line\nbreak";
    },
  ]) {
    const bytes = changed(change);
    await reject(bytes);
  }
});

test("prior public keys cannot disappear when signup availability is empty", async () => {
  const prior = (await parseFollowCatalog(fixture, options())).valid;
  const gone = changed((v) => {
    v.signup.companies = [];
    v.aliases = [];
  });
  const result = await parseFollowCatalog(gone, { ...options(gone), previousValid: prior });
  assert.equal(result.signup.companies.size, 0);
  assert.equal(result.valid.companies.size, prior.companies.size);
  const lost = changed((v) => {
    v.valid.companies = v.valid.companies.filter((x) => x !== "company without roles");
  });
  await reject(lost, { previousValid: prior });
  await reject(fixture, { previousValid: { ...empty(), fields: new Set(["not retained"]) } });
});

test("Buffer and prior membership are captured before async digest work", async () => {
  const body = Buffer.from(fixture),
    opts = options(body);
  opts.previousValid.companies.add("company without roles");
  const pending = parseFollowCatalog(body, opts);
  body.fill(0);
  opts.previousValid.companies.add("not in this approved artifact");
  const parsed = await pending;
  assert(parsed.valid.companies.has("company without roles"));
  assert(!parsed.valid.companies.has("not in this approved artifact"));
});
