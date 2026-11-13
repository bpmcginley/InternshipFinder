import { parseFollowCatalog } from "./follow-catalog.js";
import { createFollowLinkPresentation } from "./follow-link-presentation.js";
import { renderFollowMail } from "./follow-mail.js";
import { createOwnedFollowLinkRuntime } from "./follow-owned-runtime.js";
import { validFollowSendCap } from "./follow-send-budget.js";

const kinds = ["companies", "fields", "states"];
const encoder = new TextEncoder();
const digest = /^[a-f0-9]{64}$/;
const fail = () => {
  throw new Error("Follow link release unavailable");
};

function bounded(value, max) {
  return Number.isSafeInteger(value) && value >= 1 && value <= max;
}

function exact(value, keys) {
  if (
    !value ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).length !== keys.length
  )
    fail();
  const result = {};
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key);
    if (!property?.enumerable || !Object.hasOwn(property, "value")) fail();
    result[key] = property.value;
  }
  return result;
}

function bytes(value, max) {
  if (!(value instanceof Uint8Array) || !bounded(value.byteLength, max)) fail();
  return new Uint8Array(value);
}

async function readLabels(raw, { catalogSha256, sourceSha256, labelsSha256 }, valid) {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", raw));
  const hex = [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hex !== labelsSha256) fail();
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  const expected = ["version", "source_sha256", "catalog_sha256", ...kinds];
  if (
    !value ||
    Object.keys(value).join(",") !== expected.join(",") ||
    value.version !== 1 ||
    value.source_sha256 !== sourceSha256 ||
    value.catalog_sha256 !== catalogSha256
  )
    fail();
  const canonical = encoder.encode(JSON.stringify(value));
  if (raw.length !== canonical.length || raw.some((byte, index) => byte !== canonical[index]))
    fail();
  return Object.fromEntries(
    kinds.map((kind) => {
      const entries = value[kind];
      if (!Array.isArray(entries) || entries.length !== valid[kind].size) fail();
      const labels = new Map();
      for (const pair of entries) {
        if (
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          !valid[kind].has(pair[0]) ||
          labels.has(pair[0])
        )
          fail();
        labels.set(pair[0], pair[1]);
      }
      return [kind, labels];
    }),
  );
}

// The caller supplies pinned public bytes and independently qualified predecessor sets.
// No network acquisition, sender defaults, cron or deployment configuration is selected.
export async function runFollowLinkRelease(options = {}) {
  try {
    if (options.enabled !== true) return { status: "disabled" };
    const { db, email, policy, clock, catalogBytes, labelBytes, previousValid, release } = options;
    const send = email?.send;
    const settings = exact(policy, [
      "from",
      "postalAddress",
      "cap",
      "maxCandidates",
      "maxExpired",
      "transportTimeoutMs",
    ]);
    const pins = exact(release, [
      "catalogSha256",
      "sourceSha256",
      "labelsSha256",
      "notBefore",
      "expiresAt",
      "maxCatalogBytes",
      "maxLabelBytes",
      "maxKeys",
    ]);
    if (
      !db ||
      typeof clock !== "function" ||
      typeof send !== "function" ||
      !validFollowSendCap(settings.cap) ||
      !bounded(settings.maxCandidates, 64) ||
      !bounded(settings.maxExpired, 128) ||
      !bounded(settings.transportTimeoutMs, 10000) ||
      ![pins.catalogSha256, pins.sourceSha256, pins.labelsSha256].every(
        (value) => typeof value === "string" && digest.test(value),
      ) ||
      !Number.isSafeInteger(pins.notBefore) ||
      pins.notBefore < 0 ||
      !Number.isSafeInteger(pins.expiresAt) ||
      pins.notBefore >= pins.expiresAt ||
      !bounded(pins.maxCatalogBytes, 1000000) ||
      !bounded(pins.maxLabelBytes, 2000000) ||
      !bounded(pins.maxKeys, 10000)
    )
      fail();
    let last = -Infinity;
    const fresh = () => {
      const sample = clock();
      if (!(sample instanceof Date)) {
        void Promise.resolve(sample).catch(() => {});
        fail();
      }
      const at = +sample;
      if (!Number.isSafeInteger(at) || at < last || at < pins.notBefore || at >= pins.expiresAt)
        fail();
      last = at;
      return new Date(at);
    };
    fresh();
    const rawCatalog = bytes(catalogBytes, pins.maxCatalogBytes);
    const rawLabels = bytes(labelBytes, pins.maxLabelBytes);
    const catalog = await parseFollowCatalog(rawCatalog, {
      catalogSha256: pins.catalogSha256,
      sourceSha256: pins.sourceSha256,
      maxBytes: pins.maxCatalogBytes,
      maxKeys: pins.maxKeys,
      previousValid: exact(previousValid, kinds),
    });
    fresh();
    const labels = await readLabels(rawLabels, pins, catalog.valid);
    fresh();
    const presentation = createFollowLinkPresentation({
      from: settings.from,
      postalAddress: settings.postalAddress,
      labels,
    });
    // Validate presentation before acquiring ownership, using only synthetic credentials.
    const preview = presentation.management;
    renderFollowMail("manage", {
      ...preview.presentation,
      to: "preview@example.test",
      links: preview.buildLinks({
        management: `00000000-0000-4000-8000-000000000001.${"0".repeat(64)}`,
        unsubscribe: `00000000-0000-4000-8000-000000000002.${"0".repeat(64)}`,
      }),
    });
    const selected = Object.freeze({ sending: true, cap: settings.cap, ...presentation });
    fresh();
    const run = createOwnedFollowLinkRuntime({
      enabled: true,
      db,
      email: { send: (message) => Reflect.apply(send, email, [message]) },
      policy: () => {
        fresh();
        return selected;
      },
      clock: fresh,
      transportTimeoutMs: settings.transportTimeoutMs,
    });
    const { status } = await run({
      maxCandidates: settings.maxCandidates,
      maxExpired: settings.maxExpired,
    });
    return { status };
  } catch {
    return { status: "unavailable" };
  }
}
