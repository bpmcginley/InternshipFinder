import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { runFollowLinkRelease } from "../src/follow-link-release.js";
import { requestFollowConfirmation } from "../src/follows.js";

const encoder = new TextEncoder();
const sourceSha256 = "a".repeat(64);
const at = () => new Date();
const kinds = { companies: ["fixture", "retained"], fields: ["software"], states: ["NY"] };
const pack = (value) => encoder.encode(JSON.stringify(value));
const sha = async (body) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

async function fixture(overrides = {}) {
  const catalogBytes = pack({
    version: 1,
    source_sha256: sourceSha256,
    signup: { ...kinds, companies: ["fixture"] },
    valid: kinds,
    aliases: [["Fixture Labs", "fixture"]],
  });
  const catalogSha256 = await sha(catalogBytes);
  const labels = {
    version: 1,
    source_sha256: sourceSha256,
    catalog_sha256: catalogSha256,
    companies: [
      ["fixture", "Fixture Labs"],
      ["retained", "Retained Labs"],
    ],
    fields: [["software", "Software Engineering"]],
    states: [["NY", "New York"]],
    ...overrides,
  };
  const labelBytes = pack(labels);
  const now = +at();
  return {
    enabled: true,
    db: env.DB,
    email: { send: vi.fn(async () => ({ messageId: "synthetic-message" })) },
    clock: at,
    catalogBytes,
    labelBytes,
    previousValid: { companies: new Set(["retained"]), fields: new Set(), states: new Set() },
    policy: {
      from: "InternScout <sender@example.test>",
      postalAddress: "1 Fixture Avenue",
      cap: 3,
      maxCandidates: 1,
      maxExpired: 1,
      transportTimeoutMs: 1000,
    },
    release: {
      catalogSha256,
      sourceSha256,
      labelsSha256: await sha(labelBytes),
      notBefore: now - 1000,
      expiresAt: now + 60000,
      maxCatalogBytes: 8192,
      maxLabelBytes: 8192,
      maxKeys: 20,
    },
  };
}

it("preflights release and labels without touching the owner or transport", async () => {
  const denied = vi.fn(() => {
    throw Error("unexpected D1");
  });
  const db = { prepare: denied, batch: denied };
  expect(
    await runFollowLinkRelease({
      enabled: false,
      get db() {
        throw Error();
      },
    }),
  ).toEqual({ status: "disabled" });
  for (const override of [
    { source_sha256: "b".repeat(64) },
    { catalog_sha256: "b".repeat(64) },
    { companies: [["fixture", "Fixture Labs"]] },
    {
      companies: [
        ["fixture", "Fixture Labs"],
        ["fixture", "Duplicate Labs"],
      ],
    },
    { states: [["NY", "Injected\nLabel"]] },
  ]) {
    const input = await fixture(override);
    expect(await runFollowLinkRelease({ ...input, db })).toEqual({ status: "unavailable" });
    expect(input.email.send).not.toHaveBeenCalled();
  }
  const input = await fixture();
  for (const changes of [
    { policy: { ...input.policy, from: "invalid address" } },
    { release: { ...input.release, labelsSha256: "b".repeat(64) } },
    { previousValid: { ...input.previousValid, companies: new Set(["missing"]) } },
    { clock: () => new Date(input.release.expiresAt) },
    { release: { ...input.release, maxLabelBytes: 1 } },
  ])
    expect(await runFollowLinkRelease({ ...input, db, ...changes })).toEqual({
      status: "unavailable",
    });
  expect(denied).not.toHaveBeenCalled();
  expect(input.email.send).not.toHaveBeenCalled();
});

it("checks the same release cutoff after awaiting the raw catalog hash", async () => {
  const input = await fixture();
  let calls = 0;
  const db = { prepare: vi.fn(), batch: vi.fn() };
  const clock = () => new Date(++calls === 1 ? input.release.notBefore : input.release.expiresAt);
  expect(await runFollowLinkRelease({ ...input, db, clock })).toEqual({ status: "unavailable" });
  expect(calls).toBe(2);
  expect(db.prepare).not.toHaveBeenCalled();
  expect(input.email.send).not.toHaveBeenCalled();
});

it("delivers the existing exact email through the native owner and synthetic binding", async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  const input = await fixture();
  const previous = await env.DB.prepare("SELECT generation FROM follow_delivery_owner").first();
  const scope = { kind: "company", company: "retained" };
  await requestFollowConfirmation(
    env.DB,
    "reader@example.test",
    scope,
    {
      companies: new Set(kinds.companies),
      fields: new Set(kinds.fields),
      states: new Set(kinds.states),
    },
    at(),
  );
  const result = await runFollowLinkRelease(input);
  expect(result.status).toBe("processed");
  expect(result).toEqual({ status: "processed" });
  expect(input.email.send).toHaveBeenCalledOnce();
  const [envelope] = input.email.send.mock.calls[0];
  expect(envelope.text).toContain("You asked for new internships matching Retained Labs.");
  expect(envelope.text).toContain(
    "https://internscout.org/follows/action.html#purpose=confirm&token=",
  );
  expect(envelope.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  const after = await env.DB.prepare("SELECT generation,phase FROM follow_delivery_owner").first();
  expect(after.phase).toBe("ready");
  expect(after.generation).not.toBe(previous.generation);
});

it("enforces intrinsic byte and predecessor bounds before taking the owner", async () => {
  class MisleadingBytes extends Uint8Array {
    get byteLength() {
      return 1;
    }
  }
  class MisleadingSet extends Set {
    get size() {
      return 0;
    }
    *[Symbol.iterator]() {
      throw Error("must not invoke caller iterator");
    }
  }
  const input = await fixture();
  const denied = vi.fn(() => {
    throw Error("unexpected D1");
  });
  const db = { prepare: denied, batch: denied };
  for (const changes of [
    {
      labelBytes: new MisleadingBytes(input.labelBytes),
      release: { ...input.release, maxLabelBytes: 1 },
    },
    {
      catalogBytes: new MisleadingBytes(input.catalogBytes),
      release: { ...input.release, maxCatalogBytes: 1 },
    },
    {
      previousValid: {
        ...input.previousValid,
        companies: new MisleadingSet(Array.from({ length: 21 }, (_, i) => `key-${i}`)),
      },
    },
  ]) {
    expect(await runFollowLinkRelease({ ...input, db, ...changes })).toEqual({
      status: "unavailable",
    });
  }
  expect(await runFollowLinkRelease(Object.create({ ...input, db }))).toEqual({
    status: "disabled",
  });
  const getter = vi.fn(() => db);
  const accessor = { ...input };
  Object.defineProperty(accessor, "db", { enumerable: true, get: getter });
  expect(await runFollowLinkRelease(accessor)).toEqual({ status: "unavailable" });
  expect(getter).not.toHaveBeenCalled();
  expect(denied).not.toHaveBeenCalled();
  expect(input.email.send).not.toHaveBeenCalled();
});
