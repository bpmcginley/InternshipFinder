// Dormant one-attempt composition; capability issuance requires an explicit trusted builder.
import { prepareLeasedFollowDigest } from "./follow-digest-prepare.js";
import { renderFollowMail } from "./follow-mail.js";
import { createFollowCapability } from "./follows.js";
import { validFollowSendCap } from "./follow-send-budget.js";
import {
  leaseFollowDigest,
  beginBudgetedFollowSnapshotAttempt,
  authorizeFollowSnapshotTransport,
  finishFollowDigestAttempt,
} from "./follow-outbox.js";

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
    lease = await leaseFollowDigest(db, jobId, fresh());
    if (!lease) return unavailable();
    const prepared = await prepareLeasedFollowDigest(db, jobId, lease, {
      catalog,
      limits,
      loadSnapshot,
      clock: fresh,
    });
    if (prepared.status !== "ready") return unavailable();
    const recipient = await db
      .prepare("SELECT email FROM follow_subscribers WHERE id=?")
      .bind(prepared.subscriberId)
      .first("email");
    if (typeof recipient !== "string") return unavailable();
    // Snapshot public roles before calling trusted presentation code. It receives no email.
    const matches = prepared.roles.map((role) => ({ ...role }));
    const presentation = await present({
      subscriberId: prepared.subscriberId,
      roles: prepared.roles.map((role) => ({ ...role })),
    });
    let credentials = null,
      bound = presentation;
    if (buildLinks !== null) {
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
        ...presentation,
        links: {
          ...presentation?.links,
          ...privateLinks(buildLinks, management.raw, unsubscribe.raw),
        },
      };
    }
    const envelope = renderFollowMail("digest", { ...bound, matches, to: recipient });
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
