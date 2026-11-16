import {
  loadFollowCatalog,
  loadFollowPublicBytes,
  prepareFollowCatalogRelease,
  prepareFollowPublicRead,
} from "./follow-catalog-loader.js";
import { runFollowLinkRelease } from "./follow-link-release.js";
import { createFollowLinkPresentation } from "./follow-link-presentation.js";
import { renderFollowMail } from "./follow-mail.js";
import { validFollowSendCap } from "./follow-send-budget.js";

const ORIGIN = "https://internscout.org";
const empty = () => ({ companies: new Set(), fields: new Set(), states: new Set() });
const fail = () => {
  throw Error("Follow scheduled links unavailable");
};
const bounded = (n, max) => Number.isSafeInteger(n) && n > 0 && n <= max;
const shape = (v, keys) =>
  v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).sort().join(",") === keys;

function descriptor(raw) {
  if (typeof raw !== "string" || raw.length > 8192 || new TextEncoder().encode(raw).length > 8192)
    fail();
  const value = JSON.parse(raw);
  // JSON has already parsed successfully; compare decoded names in each object.
  const stack = [];
  let previous;
  for (const [token] of raw.matchAll(/"(?:[^"\\]|\\.)*"|[{}:]/g)) {
    if (token === "{") stack.push(new Set());
    if (token === "}") stack.pop();
    if (token === ":") {
      const name = JSON.parse(previous),
        names = stack.at(-1);
      if (names.has(name)) fail();
      names.add(name);
    }
    previous = token;
  }
  if (
    !shape(value, "deadlineMs,origin,policy,predecessor,release,version") ||
    value.version !== 1 ||
    value.origin !== ORIGIN ||
    !bounded(value.deadlineMs, 2147483647)
  )
    fail();
  const { release: r, policy: p } = value;
  if (
    !shape(
      r,
      "catalogSha256,catalogUrl,expiresAt,labelsSha256,labelsUrl,maxCatalogBytes,maxKeys,maxLabelBytes,notBefore,sourceSha256",
    ) ||
    !shape(p, "cap,from,maxCandidates,maxExpired,postalAddress,transportTimeoutMs") ||
    !bounded(r.maxCatalogBytes, 1000000) ||
    !bounded(r.maxLabelBytes, 2000000) ||
    !bounded(r.maxKeys, 10000) ||
    typeof r.labelsSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(r.labelsSha256) ||
    !Number.isFinite(+new Date(r.expiresAt)) ||
    !validFollowSendCap(p.cap) ||
    !bounded(p.maxCandidates, 64) ||
    !bounded(p.maxExpired, 128) ||
    !bounded(p.transportTimeoutMs, 10000)
  )
    fail();
  const current = prepareFollowCatalogRelease({
    origin: ORIGIN,
    maxBytes: r.maxCatalogBytes,
    maxKeys: r.maxKeys,
    deadlineMs: value.deadlineMs,
    previousValid: empty(),
    release: {
      url: r.catalogUrl,
      catalogSha256: r.catalogSha256,
      sourceSha256: r.sourceSha256,
      notBefore: r.notBefore,
      expiresAt: r.expiresAt,
    },
  });
  const labels = prepareFollowPublicRead({
    ...current,
    maxBytes: r.maxLabelBytes,
    release: { url: r.labelsUrl, notBefore: r.notBefore, expiresAt: r.expiresAt },
  });
  let predecessor = null;
  if (!(shape(value.predecessor, "genesis") && value.predecessor.genesis === true)) {
    if (!shape(value.predecessor, "catalogSha256,sourceSha256,url")) fail();
    predecessor = prepareFollowCatalogRelease({
      ...current,
      release: { ...current.release, ...value.predecessor },
    });
  }
  if (
    new Set([
      current.release.url,
      labels.release.url,
      ...(predecessor ? [predecessor.release.url] : []),
    ]).size !== (predecessor ? 3 : 2)
  )
    fail();
  const preview = createFollowLinkPresentation({
    from: p.from,
    postalAddress: p.postalAddress,
    labels: { companies: new Map(), fields: new Map(), states: new Map() },
  }).management;
  renderFollowMail("manage", {
    ...preview.presentation,
    to: "preview@example.test",
    links: preview.buildLinks({
      management: `00000000-0000-4000-8000-000000000001.${"0".repeat(64)}`,
      unsubscribe: `00000000-0000-4000-8000-000000000002.${"0".repeat(64)}`,
    }),
  });
  return { value, current, labels, predecessor };
}

// Consumed by the real scheduled entry. No acquisition cache, retry, sender or trigger defaults.
export async function runFollowScheduledLinks(
  env,
  {
    fetch: get = (...args) => fetch(...args),
    now = () => new Date(),
    monotonicNow = () => performance.now(),
  } = {},
) {
  if (env?.FOLLOW_LINKS_ENABLED !== "1") return { status: "disabled" };
  try {
    const { value, current, labels, predecessor } = descriptor(env.FOLLOW_LINKS_RELEASE);
    const db = env.DB,
      binding = env.EMAIL,
      send = binding?.send;
    if (
      !db ||
      typeof send !== "function" ||
      [get, now, monotonicNow].some((v) => typeof v !== "function")
    )
      fail();
    // Capture binding identity and function before the first await.
    const email = { send: (message) => Reflect.apply(send, binding, [message]) };
    let lastWall = -Infinity,
      lastMono = -Infinity;
    const clock = () => {
      const sample = now();
      if (!(sample instanceof Date)) {
        void Promise.resolve(sample).catch(() => {});
        fail();
      }
      const at = +sample;
      if (
        !Number.isSafeInteger(at) ||
        at < lastWall ||
        at < value.release.notBefore ||
        at >= value.release.expiresAt
      )
        fail();
      lastWall = at;
      return new Date(at);
    };
    const mono = () => {
      const at = monotonicNow();
      if (!Number.isFinite(at) || at < 0 || at < lastMono) {
        void Promise.resolve(at).catch(() => {});
        fail();
      }
      lastMono = at;
      return at;
    };
    const wallStart = +clock(),
      monoStart = mono();
    const remaining = () => {
      const left = value.deadlineMs - Math.max(+clock() - wallStart, mono() - monoStart);
      if (left <= 0) fail();
      return Math.ceil(left);
    };
    const read = (selected, loader) =>
      loader({
        ...selected,
        enabled: true,
        fetch: get,
        deadlineMs: remaining(),
        now: () => {
          remaining();
          return lastWall;
        },
      });
    let previousValid = empty();
    if (predecessor) {
      const prior = await read(predecessor, loadFollowCatalog);
      remaining();
      if (prior.status !== "available") fail();
      previousValid = prior.catalog.valid;
    }
    const catalog = await read(current, loadFollowPublicBytes);
    remaining();
    if (catalog.status !== "available") fail();
    const label = await read(labels, loadFollowPublicBytes);
    remaining();
    if (label.status !== "available") fail();
    const release = { ...value.release };
    delete release.catalogUrl;
    delete release.labelsUrl;
    // The shared budget also fences hashing and new work; never race an admitted
    // DB write or provider settlement. Existing owner finalization remains authoritative.
    return await runFollowLinkRelease({
      enabled: true,
      db,
      email,
      policy: value.policy,
      clock: () => {
        remaining();
        return new Date(lastWall);
      },
      catalogBytes: catalog.bytes,
      labelBytes: label.bytes,
      previousValid,
      release,
    });
  } catch {
    return { status: "unavailable" };
  }
}
