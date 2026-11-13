import { expireFollowDigestCandidate } from "./follow-digest-expiry-candidate.js";
import { expireFollowDigestPage } from "./follow-digest-expiry-page.js";
import { expireFollowPage } from "./follow-expiry-page.js";
import { expireFollowManagementRequests } from "./follow-retention.js";
import {
  expireFollowOrphanPage,
  expireFollowUnconfirmedPage,
} from "./follow-subscriber-expiry-page.js";

const policyKeys = "deadlineMs,maxD1Calls,maxRows";
const bounded = (value, max) => Number.isSafeInteger(value) && value >= 1 && value <= max;

export function runFollowScheduledMaintenance(db, rawPolicy, now = () => performance.now()) {
  return runMaintenance(db, rawPolicy, now);
}

// Measurement is ephemeral and cannot influence admission or maintenance status.
export async function measureFollowScheduledMaintenance(
  db,
  rawPolicy,
  measurementClock = () => performance.now(),
  now = () => performance.now(),
) {
  const sample = () => {
    try {
      const value = measurementClock();
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
      void Promise.resolve(value).catch(() => {});
    } catch {
      /* Invalid measurement suppresses only observation. */
    }
    return null;
  };
  const start = sample();
  let d1Calls = 0;
  const result = await runMaintenance(db, rawPolicy, now, () => {
    d1Calls++;
  });
  const end = sample(),
    durationMs = Math.ceil(end - start);
  const observation =
    start !== null &&
    end !== null &&
    end >= start &&
    Number.isSafeInteger(durationMs) &&
    d1Calls <= 48
      ? { status: result.status, durationMs, d1Calls }
      : null;
  return { result, observation };
}

async function runMaintenance(db, rawPolicy, now, countCall) {
  try {
    if (typeof rawPolicy !== "string" || rawPolicy.length > 256) return { status: "unavailable" };
    const policy = JSON.parse(rawPolicy);
    if (
      !policy ||
      ![policyKeys, "deadlineMs,digestCandidates,maxD1Calls,maxRows"].includes(
        Object.keys(policy).sort().join(","),
      ) ||
      (Object.hasOwn(policy, "digestCandidates") && typeof policy.digestCandidates !== "boolean")
    )
      return { status: "unavailable" };
    const { deadlineMs, maxD1Calls, maxRows, digestCandidates = false } = policy;
    // One page per unfinished lane per round. Count D1 calls across rounds.
    if (!bounded(deadlineMs, 30000) || !bounded(maxD1Calls, 48) || !bounded(maxRows, 128))
      return { status: "unavailable" };
    if (Object.hasOwn(policy, "digestCandidates")) {
      // Only a flat scalar policy can reach here. Count decoded member names so
      // an escaped duplicate cannot turn an explicit false into true.
      const names = new Set();
      for (const match of rawPolicy.matchAll(/("(?:[^"\\]|\\.)*")\s*:/g)) {
        const name = JSON.parse(match[1]);
        if (names.has(name)) return { status: "unavailable" };
        names.add(name);
      }
    }

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
    // Both readers and mutations consume calls. Binding preserves the wrapper,
    // and each resolved operation fences the next one against elapsed time.
    const statements = new WeakMap();
    const execute = async (operation) => {
      admit();
      const result = await operation();
      if (!hasTime()) {
        exhausted = true;
        throw new Error("Maintenance deadline exhausted");
      }
      return result;
    };
    const wrap = (statement) => {
      const wrapped = {
        bind: (...values) => wrap(statement.bind(...values)),
        all: () =>
          execute(() => {
            const all = statement.all;
            if (typeof all !== "function") throw new Error("Maintenance binding unavailable");
            countCall?.();
            return Reflect.apply(all, statement, []);
          }),
      };
      statements.set(wrapped, statement);
      return wrapped;
    };
    const budgetedDb = {
      prepare: (sql) => wrap(db.prepare(sql)),
      batch: (batch) =>
        execute(() => {
          const native = batch.map((statement) => {
            if (!statements.has(statement)) throw new Error("Unknown maintenance statement");
            return statements.get(statement);
          });
          const perform = db.batch;
          if (typeof perform !== "function") throw new Error("Maintenance binding unavailable");
          countCall?.();
          return Reflect.apply(perform, db, [native]);
        }),
    };
    const page = { enabled: true, maxRows };
    const lanes = [
      (cursor) => expireFollowPage(budgetedDb, { ...page, kind: "confirmation", cursor }),
      (cursor) => expireFollowPage(budgetedDb, { ...page, kind: "tokens", cursor }),
      (cursor) => expireFollowUnconfirmedPage(budgetedDb, { ...page, cursor }),
      (cursor) => expireFollowOrphanPage(budgetedDb, { ...page, maxChildren: maxRows, cursor }),
      (cursor) =>
        digestCandidates
          ? expireFollowDigestCandidate(budgetedDb, { enabled: true })
          : expireFollowDigestPage(budgetedDb, { ...page, maxRows: 1, cursor }),
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
        const cost = lane === digests ? (digestCandidates ? 3 : 2) : 1;
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
