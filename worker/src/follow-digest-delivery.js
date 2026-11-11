// Dormant one-attempt composition; no provider binding, route, scheduler or token issuance.
import { prepareLeasedFollowDigest } from "./follow-digest-prepare.js";
import { renderFollowMail } from "./follow-mail.js";
import { validFollowSendCap } from "./follow-send-budget.js";
import {
  leaseFollowDigest,
  beginBudgetedFollowSnapshotAttempt,
  authorizeFollowSnapshotTransport,
  finishFollowDigestAttempt,
} from "./follow-outbox.js";

// present is trusted server code: links/similar facts must be authorized for subscriberId.
// transport resolves only on known acceptance and rejects on rejection/uncertainty.
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
}) {
  const unavailable = () => ({ status: "unavailable" });
  if (
    !validFollowSendCap(cap) ||
    [clock, loadSnapshot, present, transport].some((f) => typeof f !== "function")
  )
    return unavailable();
  let lease,
    claimed = false,
    outcome = "uncertain",
    latest = -Infinity;
  const fresh = () => {
    const now = clock();
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
    const envelope = renderFollowMail("digest", { ...presentation, matches, to: recipient });
    if (!envelope) return unavailable();
    const attempt = await beginBudgetedFollowSnapshotAttempt(db, key, jobId, lease, cap, fresh);
    if (attempt !== "claimed") return attempt === "paused" ? { status: "paused" } : unavailable();
    claimed = true;
    if (
      await authorizeFollowSnapshotTransport(
        db,
        jobId,
        lease,
        prepared.subscriberId,
        recipient,
        fresh,
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
