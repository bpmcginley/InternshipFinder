// Dormant single attempt. URL construction and the immediate transport are trusted injected ports.
import { claimFollowManagementRequest } from "./follow-management-claim.js";
import { renderFollowMail } from "./follow-mail.js";
import { followBudgetStamp, validFollowSendCap } from "./follow-send-budget.js";
const TOKEN = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.[a-f0-9]{64}$/;
const TOKENS = /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.[a-f0-9]{64}/gi;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const unavailable = () => ({ status: "unavailable" });
const hash = async (value) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
const stamp = (v) =>
  typeof v === "string" &&
  v.length === 24 &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString() === v;
// A public endpoint/fragment grammar is not selected here. Bind exact credentials to the existing renderer's private slots.
function boundLinks(buildLinks, credentials) {
  const values = buildLinks(Object.freeze({ ...credentials }));
  if (values && typeof values.then === "function") {
    Promise.resolve(values).catch(() => {});
    throw new Error();
  }
  const links = {};
  for (const name of ["management", "unsubscribe"]) {
    const value = values?.[name],
      token = credentials[name];
    if (typeof value !== "string" || value.length > 2000) throw new Error();
    const matches = decodeURIComponent(value).match(TOKENS) || [];
    if (matches.length !== 1 || matches[0] !== token) throw new Error();
    links[name] = value;
  }
  return links;
}
function oneRow(results) {
  const result = results?.[0];
  if (
    !Array.isArray(results) ||
    results.length !== 1 ||
    !Object.hasOwn(results, 0) ||
    result?.success !== true ||
    result.meta?.changes !== 0 ||
    !Array.isArray(result.results) ||
    result.results.length !== 1
  )
    return null;
  const row = result.results[0];
  return row && typeof row === "object" && !Array.isArray(row) ? row : null;
}
async function readJob(db, jobId) {
  const row = oneRow(
    await db.batch([
      db
        .prepare(
          `SELECT q.subscriber_id,q.queued_at,q.expires_at,u.email
    FROM follow_management_outbox q JOIN follow_subscribers u ON u.id=q.subscriber_id
    WHERE q.id=? AND q.claim_id IS NULL AND q.queued_at<=${NOW} AND q.expires_at>${NOW}
      AND EXISTS(SELECT 1 FROM follow_subscriptions s WHERE s.subscriber_id=q.subscriber_id)`,
        )
        .bind(jobId),
    ]),
  );
  if (
    !row ||
    Object.keys(row).sort().join(",") !== "email,expires_at,queued_at,subscriber_id" ||
    typeof row.subscriber_id !== "string" ||
    !row.subscriber_id ||
    typeof row.email !== "string" ||
    !stamp(row.queued_at) ||
    !stamp(row.expires_at)
  )
    return null;
  return { ...row };
}
async function freshFence(db, claimed, job) {
  if (
    ![claimed.management, claimed.unsubscribe].every(
      (v) => typeof v === "string" && TOKEN.test(v),
    ) ||
    !stamp(claimed.expiresAt)
  )
    return null;
  const [management, unsubscribe] = await Promise.all([
    hash(claimed.management),
    hash(claimed.unsubscribe),
  ]);
  const results = await db.batch([
    db
      .prepare(
        `SELECT q.expires_at,${NOW} AS at
    FROM follow_management_outbox q JOIN follow_subscribers u ON u.id=q.subscriber_id
    JOIN follow_tokens m ON m.subscriber_id=q.subscriber_id AND m.token_hash=? AND m.generation=?
      AND m.purpose='manage' AND m.scope_key='' AND m.owner_user_hash IS NULL AND m.expires_at=?
    JOIN follow_tokens v ON v.subscriber_id=q.subscriber_id AND v.token_hash=? AND v.generation=?
      AND v.purpose='unsubscribe' AND v.scope_key='' AND v.owner_user_hash IS NULL AND v.expires_at IS NULL
    WHERE q.id=? AND q.claim_id=? AND u.email=? AND q.subscriber_id=? AND q.queued_at=? AND q.expires_at=?
      AND q.queued_at<=${NOW} AND q.expires_at>${NOW}
      AND m.expires_at>${NOW} AND date(m.expires_at,'-30 minutes')=date('now')
      AND EXISTS(SELECT 1 FROM follow_subscriptions s WHERE s.subscriber_id=q.subscriber_id)`,
      )
      .bind(
        management,
        claimed.management.slice(0, 36),
        claimed.expiresAt,
        unsubscribe,
        claimed.unsubscribe.slice(0, 36),
        claimed.jobId,
        claimed.claimId,
        claimed.email,
        job.subscriber_id,
        job.queued_at,
        job.expires_at,
      ),
  ]);
  const row = oneRow(results);
  if (
    !row ||
    Array.isArray(row) ||
    Object.keys(row).sort().join(",") !== "at,expires_at" ||
    !stamp(row.at) ||
    !stamp(row.expires_at) ||
    row.expires_at !== job.expires_at
  )
    return null;
  return row;
}
export async function deliverFollowManagement({
  enabled = false,
  db,
  jobId,
  cap,
  clock,
  presentation,
  buildLinks,
  transport,
} = {}) {
  if (enabled !== true) return { status: "disabled" };
  if (
    !validFollowSendCap(cap) ||
    [clock, buildLinks, transport].some((f) => typeof f !== "function")
  )
    return unavailable();
  let envelope;
  try {
    // Copy before any await. The caller cannot swap configuration or ports during issuance.
    const config = {
      from: presentation?.from,
      postalAddress: presentation?.postalAddress,
      origins: Array.isArray(presentation?.origins) ? [...presentation.origins] : null,
    };
    const probe = {
      management: "00000000-0000-0000-0000-000000000000." + "0".repeat(64),
      unsubscribe: "11111111-1111-1111-1111-111111111111." + "1".repeat(64),
    };
    const previewLinks = boundLinks(buildLinks, probe);
    renderFollowMail("manage", { ...config, to: "preview@example.test", links: previewLinks });
    let previous = followBudgetStamp(clock());
    if (!previous) return unavailable();
    const started = previous;
    const current = () => {
      const value = followBudgetStamp(clock());
      if (!value || value < previous) throw new Error();
      previous = value;
      return value;
    };
    const job = await readJob(db, jobId);
    if (!job || current() >= job.expires_at) return unavailable();
    renderFollowMail("manage", { ...config, to: job.email, links: previewLinks });
    const claimed = await claimFollowManagementRequest(db, jobId, { enabled: true, cap });
    if (claimed.status !== "claimed" || claimed.email !== job.email) return unavailable();
    if (current() >= claimed.expiresAt) return unavailable();
    envelope = renderFollowMail("manage", {
      ...config,
      to: claimed.email,
      links: boundLinks(buildLinks, {
        management: claimed.management,
        unsubscribe: claimed.unsubscribe,
      }),
    });
    const receipt = await freshFence(db, claimed, job);
    const checked = current();
    if (
      !receipt ||
      started.slice(0, 10) !== receipt.at.slice(0, 10) ||
      checked.slice(0, 10) !== receipt.at.slice(0, 10) ||
      checked >= receipt.expires_at ||
      checked >= claimed.expiresAt
    )
      return unavailable();
  } catch {
    return unavailable();
  }
  try {
    // No await occurs between the final clock/DB fence and this one immediate handoff.
    const result = transport(envelope);
    if (!result || typeof result.then !== "function") return { status: "uncertain" };
    await result;
    return { status: "accepted" };
  } catch {
    return { status: "uncertain" };
  }
}
