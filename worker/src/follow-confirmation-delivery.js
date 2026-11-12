// Dormant one-job attempt. Presentation and immediate transport are trusted, injected ports.
import {
  commitFollowConfirmationClaim,
  prepareFollowConfirmationClaim,
  readFollowConfirmationClock,
  readFollowConfirmationTransportFence,
  readUnclaimedFollowConfirmation,
} from "./follow-confirmation-claim.js";
import { renderFollowMail } from "./follow-mail.js";
import { followBudgetStamp, validFollowSendCap } from "./follow-send-budget.js";

// Bind the strings actually handed to the renderer to the hashes in the final fence.
function boundLinks(links, { confirm, deletion, unsubscribe }) {
  const checked = {};
  for (const [name, token, purpose] of [
    ["confirmation", confirm.raw, "confirm"],
    ["deleteRequest", deletion.raw, "delete-request"],
    ["unsubscribe", unsubscribe.raw, null],
  ]) {
    const link = links?.[name];
    if (typeof link !== "string") throw new Error("Invalid confirmation links");
    const url = new URL(link);
    const matches = link.includes("#")
      ? purpose && !url.search && url.hash === `#purpose=${purpose}&token=${token}`
      : url.search === `?token=${token}`;
    if (!matches) throw new Error("Invalid confirmation links");
    checked[name] = link;
  }
  return checked;
}

export async function deliverFollowConfirmation({ db, jobId, cap, clock, present, transport }) {
  const unavailable = () => ({ status: "unavailable" });
  if (!validFollowSendCap(cap) || [clock, present, transport].some((f) => typeof f !== "function"))
    return unavailable();
  let envelope;
  try {
    const job = await readUnclaimedFollowConfirmation(db, jobId);
    if (!job) return unavailable();
    const prepared = await prepareFollowConfirmationClaim();
    // Render before spending either the job or capacity. The port receives no recipient address.
    const { links, ...presentation } = await present({
      scopeKey: job.scope_key,
      confirmation: prepared.confirm.raw,
      deleteRequest: prepared.deletion.raw,
      unsubscribe: prepared.unsubscribe.raw,
    });
    envelope = renderFollowMail("confirm", {
      ...presentation,
      links: boundLinks(links, prepared),
      to: job.email,
    });
    const started = followBudgetStamp(clock());
    if (!started || started >= job.expires_at) return unavailable();
    const at = await readFollowConfirmationClock(db);
    const live = (stamp, lower) =>
      stamp && stamp >= lower && stamp.slice(0, 10) === at.slice(0, 10) && stamp < job.expires_at;
    const beforeClaim = followBudgetStamp(clock());
    if (!live(started, started) || !live(beforeClaim, started) || at >= job.expires_at)
      return unavailable();
    const { status } = await commitFollowConfirmationClaim(db, jobId, prepared, { job, at, cap });
    const checked = followBudgetStamp(clock());
    if (!live(checked, beforeClaim)) return unavailable();
    if (status !== "claimed") return { status };
    if (
      !(await readFollowConfirmationTransportFence(db, jobId, job, prepared, at)) ||
      !live(followBudgetStamp(clock()), checked)
    )
      return unavailable();
  } catch {
    // A missing or malformed D1 acknowledgement grants no permission to send.
    return unavailable();
  }
  try {
    // Invoke synchronously after the final fence. The port never queues or retries a send.
    const result = transport(envelope);
    if (!result || typeof result.then !== "function") return { status: "uncertain" };
    await result;
    return { status: "accepted" };
  } catch {
    return { status: "uncertain" };
  }
}
