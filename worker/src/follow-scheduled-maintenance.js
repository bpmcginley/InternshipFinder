import { expireFollowDigestPage } from "./follow-digest-expiry-page.js";
import { expireFollowPage } from "./follow-expiry-page.js";
import { expireFollowManagementRequests } from "./follow-retention.js";
import {
  expireFollowOrphanPage,
  expireFollowUnconfirmedPage,
} from "./follow-subscriber-expiry-page.js";

const policyKeys = "deadlineMs,maxD1Calls,maxRows";
const bounded = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max;

export async function runFollowScheduledMaintenance(db, rawPolicy, now = () => performance.now()) {
  try {
    if (typeof rawPolicy !== "string" || rawPolicy.length > 256) return { status: "unavailable" };
    const policy = JSON.parse(rawPolicy);
    if (!policy || Object.keys(policy).sort().join(",") !== policyKeys)
      return { status: "unavailable" };
    const { deadlineMs, maxD1Calls, maxRows } = policy;
    // One page per unfinished lane per round. Count D1 calls across rounds.
    if (!bounded(deadlineMs, 30000) || !bounded(maxD1Calls, 48) || !bounded(maxRows, 128))
      return { status: "unavailable" };

    const start = now();
    if (!Number.isFinite(start) || start < 0) return { status: "unavailable" };
    let latest = start;
    const hasTime = () => {
      const sample = now();
      if (!Number.isFinite(sample) || sample < latest)
        throw new Error("Maintenance clock unavailable");
      latest = sample;
      return sample - start < deadlineMs;
    };
    let remainingCalls = maxD1Calls;
    let exhausted = false;
    const admit = () => {
      if (remainingCalls === 0 || !hasTime()) {
        exhausted = true;
        throw new Error("Maintenance budget exhausted");
      }
      remainingCalls--;
    };
    // The digest page reads D1 time before its batch. Fence both calls, including after that await.
    const budgetedDb = {
      prepare(sql) {
        const statement = db.prepare(sql);
        return sql.startsWith("SELECT strftime(")
          ? {
              all: () => {
                admit();
                return statement.all();
              },
            }
          : statement;
      },
      batch(statements) {
        admit();
        return db.batch(statements);
      },
    };
    const page = { enabled: true, maxRows };
    const lanes = [
      (cursor) => expireFollowPage(budgetedDb, { ...page, kind: "confirmation", cursor }),
      (cursor) => expireFollowPage(budgetedDb, { ...page, kind: "tokens", cursor }),
      (cursor) => expireFollowUnconfirmedPage(budgetedDb, { ...page, cursor }),
      (cursor) => expireFollowOrphanPage(budgetedDb, { ...page, maxChildren: maxRows, cursor }),
      (cursor) => expireFollowDigestPage(budgetedDb, { ...page, maxRows: 1, cursor }),
      (cursor) => expireFollowPage(budgetedDb, { ...page, kind: "digest-days", cursor }),
      async () => {
        const result = await expireFollowManagementRequests(budgetedDb, page);
        return {
          ...result,
          complete: result.status === "maintained" && result.removed < maxRows,
          next: null,
        };
      },
    ].map((run) => ({ run, complete: false, next: null }));
    const [, tokens, scopes, orphans, digests] = lanes;

    while (remainingCalls > 0) {
      for (const lane of lanes) {
        if (lane.complete) continue;
        if ((lane === scopes && !tokens.complete) || (lane === orphans && !scopes.complete))
          continue;
        const cost = lane === digests ? 2 : 1;
        if (remainingCalls < cost || !hasTime()) return { status: "partial" };
        const result = await lane.run(lane.next);
        if (exhausted) return { status: "partial" };
        if (result.status !== "maintained") return { status: "unavailable" };
        if (!hasTime()) return { status: "partial" };
        lane.complete = result.complete;
        lane.next = result.next;
      }
      if (lanes.every((lane) => lane.complete)) return { status: "pass-complete" };
    }
    return { status: "partial" };
  } catch {
    return { status: "unavailable" };
  }
}
