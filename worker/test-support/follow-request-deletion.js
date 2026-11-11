import { deleteFollowRequest, mintFollowRequestDeletion } from "../src/follow-request-deletion.js";
import {
  confirmFollow,
  mintFollowToken,
  removeManagedFollow,
  requestFollow,
} from "../src/follows.js";

export async function deleteLastPendingScope(db, equal) {
  const now = new Date("2026-11-10T12:00:00Z");
  const email = "former-active@example.test";
  const catalog = { companies: new Set(["active", "pending"]) };
  const request = (company) => requestFollow(db, email, { kind: "company", company }, catalog, now);
  const token = ({ subscriberId, scopeKey }) =>
    mintFollowToken(db, subscriberId, "confirm", { scopeKey }, now);
  const active = await request("active");
  equal(await confirmFollow(db, await token(active), now), true);
  const pending = await request("pending");
  const deletion = await mintFollowRequestDeletion(db, await token(pending), now);
  const manage = await mintFollowToken(db, active.subscriberId, "manage", {}, now);
  equal(await removeManagedFollow(db, manage, active.scopeKey, now), true);

  const counts = () =>
    Promise.all(
      [
        "follow_subscribers",
        "follow_subscriptions",
        "follow_tokens",
        "follow_request_deletions",
      ].map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n")),
    );
  equal(await counts(), [1, 1, 2, 1]);
  equal(await deleteFollowRequest(db, deletion, now), true);
  equal(await counts(), [0, 0, 0, 0]);
}
