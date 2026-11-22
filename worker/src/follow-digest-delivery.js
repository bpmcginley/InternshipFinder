// Dormant one-attempt composition; capability issuance requires an explicit trusted builder.
import {
  prepareLeasedFollowDigest,
  captureFollowDigestRelatedLimits,
} from "./follow-digest-prepare.js";
import { renderFollowMail } from "./follow-mail.js";
import { createFollowCapability } from "./follows.js";
import { validFollowSendCap } from "./follow-send-budget.js";
import {
  leaseFollowDigest,
  beginBudgetedFollowSnapshotAttempt,
  authorizeFollowSnapshotTransport,
  finishFollowDigestAttempt,
} from "./follow-outbox.js";

// Capture only rendered public facts before exposing fresh capabilities to the builder.
// Reuse the caller's already-required result/role bounds; no separate volume policy.
function snapshotPresentation(input, matches, limits, similar) {
  let remaining = limits.maxResultBytes;
  const maxRoles = limits.maxRoles;
  if (
    !Number.isSafeInteger(remaining) ||
    remaining < 1 ||
    !Number.isSafeInteger(maxRoles) ||
    maxRoles < 1
  )
    throw new Error("Invalid digest presentation");
  const field = (value, key, optional = false) => {
    if (!value || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      throw new Error("Invalid digest presentation");
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d && optional) return undefined;
    if (!d?.enumerable || !Object.hasOwn(d, "value"))
      throw new Error("Invalid digest presentation");
    return d.value;
  };
  const text = (value, max = remaining) => {
    if (typeof value !== "string" || value.length > max || value.length > remaining)
      throw new Error("Invalid digest presentation");
    remaining -= new TextEncoder().encode(value).length + 1;
    if (remaining < 0) throw new Error("Invalid digest presentation");
    return value;
  };
  const list = (value, max, copy) => {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
      throw new Error("Invalid digest presentation");
    const length = Object.getOwnPropertyDescriptor(value, "length").value;
    if (length > max || length > remaining) throw new Error("Invalid digest presentation");
    const result = [];
    for (let i = 0; i < length; i++) {
      const d = Object.getOwnPropertyDescriptor(value, i);
      if (!d?.enumerable || !Object.hasOwn(d, "value"))
        throw new Error("Invalid digest presentation");
      result.push(copy(d.value));
    }
    return Object.freeze(result);
  };
  const publicUrl = (value) => {
    const original = text(value, 2000);
    let decoded = new URL(original).href;
    // Each decoding reduces a bounded string. Reject capabilities even through nested escapes.
    while (/%[a-f0-9]{2}/i.test(decoded)) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
    if (/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.[a-f0-9]{64}/i.test(decoded))
      throw new Error("Invalid digest public link");
    return original;
  };
  const role = (value) =>
    Object.freeze({
      id: text(field(value, "id"), 16),
      company_name: text(field(value, "company_name"), 200),
      title: text(field(value, "title"), 300),
      location: text(field(value, "location"), 300),
      apply_url: publicUrl(field(value, "apply_url")),
    });
  const links = field(input, "links");
  return Object.freeze({
    from: text(field(input, "from")),
    postalAddress: text(field(input, "postalAddress"), 500),
    origins: list(field(input, "origins"), remaining, (v) => {
      const value = text(v, 2000),
        url = new URL(value);
      if (url.protocol !== "https:" || ![url.origin, url.origin + "/"].includes(value))
        throw new Error("Invalid digest origin");
      return value;
    }),
    links: Object.freeze({
      matchingPage: publicUrl(field(links, "matchingPage")),
      publicShare: publicUrl(field(links, "publicShare")),
    }),
    matches: list(matches, maxRoles, role),
    similar: list(similar ?? field(input, "similar", true) ?? [], maxRoles, role),
  });
}

function privateLinks(buildLinks, management, unsubscribe) {
  const values = buildLinks(Object.freeze({ management, unsubscribe }));
  if (values && typeof values.then === "function") {
    Promise.resolve(values).catch(() => {});
    throw new Error("Invalid digest links");
  }
  if (!values || ![Object.prototype, null].includes(Object.getPrototypeOf(values)))
    throw new Error("Invalid digest links");
  const links = {};
  for (const [name, token] of Object.entries({ management, unsubscribe })) {
    const d = Object.getOwnPropertyDescriptor(values, name);
    const value = d && Object.hasOwn(d, "value") && d.enumerable ? d.value : null;
    if (typeof value !== "string" || value.length > 2000) throw new Error("Invalid digest links");
    const url = new URL(value);
    const expected =
      name === "management"
        ? `https://internscout.org/follows/manage.html#token=${token}`
        : `${url.origin}/follows/unsubscribe?token=${token}`;
    if (url.protocol !== "https:" || value !== expected || url.href !== expected)
      throw new Error("Invalid digest links");
    links[name] = value;
  }
  return links;
}

// present is trusted server code: links/similar facts must be authorized for subscriberId.
// transport initiates immediately or rejects busy; it must not queue behind another send.
// It resolves only on known acceptance and rejects on rejection/uncertainty.
export async function deliverFollowSnapshotDigest({
  db,
  jobId,
  key,
  cap,
  clock,
  catalog,
  limits,
  loadSnapshot,
  present,
  transport,
  buildLinks = null,
  relatedLimits,
}) {
  const unavailable = () => ({ status: "unavailable" });
  if (
    !validFollowSendCap(cap) ||
    [clock, loadSnapshot, present, transport].some((f) => typeof f !== "function") ||
    (buildLinks !== null && typeof buildLinks !== "function")
  )
    return unavailable();
  let lease,
    claimed = false,
    outcome = "uncertain",
    latest = -Infinity;
  const fresh = () => {
    const now = clock();
    if (!(now instanceof Date)) Promise.resolve(now).catch(() => {});
    if (!(now instanceof Date) || !Number.isFinite(+now) || +now < latest)
      throw new Error("Invalid follow delivery clock");
    latest = +now;
    return new Date(latest);
  };
  try {
    const related = captureFollowDigestRelatedLimits(relatedLimits);
    lease = await leaseFollowDigest(db, jobId, fresh());
    if (!lease) return unavailable();
    const prepared = await prepareLeasedFollowDigest(db, jobId, lease, {
      catalog,
      limits,
      loadSnapshot,
      clock: fresh,
      relatedLimits: related,
    });
    if (prepared.status !== "ready") return unavailable();
    const recipient = await db
      .prepare("SELECT email FROM follow_subscribers WHERE id=?")
      .bind(prepared.subscriberId)
      .first("email");
    if (typeof recipient !== "string") return unavailable();
    // Snapshot public roles before calling trusted presentation code. It receives no email.
    const matches = prepared.roles.map((role) => ({ ...role }));
    const similar =
      related === undefined ? undefined : prepared.similar.map((role) => ({ ...role }));
    const presentation = await present({
      subscriberId: prepared.subscriberId,
      roles: prepared.roles.map((role) => ({ ...role })),
    });
    let credentials = null,
      bound = presentation;
    if (similar !== undefined && buildLinks === null) {
      const { from, postalAddress, origins, links } = presentation;
      bound = { from, postalAddress, origins, links };
    }
    if (buildLinks !== null) {
      const snapshot = snapshotPresentation(presentation, matches, limits, similar);
      const [management, unsubscribe] = await Promise.all([
        createFollowCapability(),
        createFollowCapability(),
      ]);
      credentials = Object.freeze({
        subscriberId: prepared.subscriberId,
        email: recipient,
        managementHash: management.digest,
        managementGeneration: management.generation,
        unsubscribeHash: unsubscribe.digest,
        unsubscribeGeneration: unsubscribe.generation,
      });
      bound = {
        ...snapshot,
        links: {
          ...snapshot.links,
          ...privateLinks(buildLinks, management.raw, unsubscribe.raw),
        },
      };
    }
    const envelope = renderFollowMail("digest", {
      ...bound,
      matches: credentials ? bound.matches : matches,
      ...(similar === undefined ? {} : { similar: credentials ? bound.similar : similar }),
      to: recipient,
    });
    if (!envelope) return unavailable();
    const attempt = await beginBudgetedFollowSnapshotAttempt(
      db,
      key,
      jobId,
      lease,
      cap,
      fresh,
      credentials,
    );
    if ((credentials ? attempt?.status : attempt) !== "claimed")
      return attempt === "paused" ? { status: "paused" } : unavailable();
    claimed = true;
    if (
      await authorizeFollowSnapshotTransport(
        db,
        jobId,
        lease,
        prepared.subscriberId,
        recipient,
        fresh,
        credentials ? attempt : null,
      )
    ) {
      // No awaited rendering, token or presentation work may occur between this fence and send.
      const pending = transport(envelope);
      if (pending && typeof pending.then === "function") {
        await pending;
        outcome = "accepted";
      }
    }
  } catch {
    // Uncertainty is terminal; no provider details or recipient data leave this helper.
  }
  if (!claimed) return unavailable();
  try {
    return (await finishFollowDigestAttempt(db, jobId, lease, outcome, fresh()))
      ? { status: outcome }
      : unavailable();
  } catch {
    return unavailable();
  }
}
