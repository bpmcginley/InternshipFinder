import { HttpError } from "./http.js";
import {
  admit,
  aiPreflight,
  allowanceFor,
  budgetCents,
  dailyBudgetCents,
  daySpend,
  monthOf,
  nextMonth,
  upgradeOffer,
  userBudgetCents,
} from "./limits.js";
import { canUpgrade } from "./billing.js";
import { countEvent } from "./visits.js";
import { reserveFirstFundedRun } from "./funded-run-admission.js";
import { reserveFundedSibling } from "./funded-run-sibling.js";
import { purchaseFrom, purchaseSpendable } from "./funded-purchase.js";
import { fundedProviderResponse } from "./funded-provider.js";
import { releaseFundedCall } from "./funded-run-callbacks.js";
import { costCents, geminiUrl } from "./gemini.js";
const busy = () => new HttpError(503, "busy", "AI admission is temporarily unavailable");
export function lifecycleMode(env) {
  const mode = env.FUNDED_RUNS_MODE || "legacy";
  if (!["legacy", "create", "drain"].includes(mode)) throw busy();
  return mode;
}
function responseLimits(env) {
  const values = [
    env.FUNDED_RESPONSE_MAX_BYTES,
    env.FUNDED_RESPONSE_EVENT_BYTES,
    env.FUNDED_RESPONSE_DEADLINE_MS,
  ];
  if (values.some((v) => typeof v !== "string" || !/^[1-9]\d*$/.test(v))) throw busy();
  const [maxBytes, maxEventBytes, deadlineMs] = values.map(Number);
  if (
    ![maxBytes, maxEventBytes, deadlineMs].every(Number.isSafeInteger) ||
    maxEventBytes > maxBytes ||
    deadlineMs > 2147483647
  )
    throw busy();
  return { maxBytes, maxEventBytes, deadlineMs };
}
export async function admitAiLifecycle(
  db,
  env,
  config,
  user,
  task,
  runId,
  now,
  tier,
  plan,
  estimate,
) {
  const mode = lifecycleMode(env);
  if (mode === "legacy")
    return {
      kind: "legacy",
      admitted: await admit(db, env, config, user, task, runId, now, tier, plan, estimate),
    };
  const limits = responseLimits(env);
  await aiPreflight(db, env, config, user, now, plan);
  const month = monthOf(now),
    key = [user, month, task, runId];
  let row, used, bonus, purchased;
  const limit = allowanceFor(config, env, task, tier, plan, now);
  const allowPurchased = env.FUNDED_PURCHASES === "1" && task === "autofill";
  try {
    if (await db.prepare("SELECT 1 FROM forget WHERE user_hash=?").bind(user).first()) throw busy();
    row = await db
      .prepare(
        "SELECT r.calls,f.generation FROM runs r LEFT JOIN funded_runs f USING(user_hash,month,task,run_id) WHERE r.user_hash=? AND r.month=? AND r.task=? AND r.run_id=?",
      )
      .bind(...key)
      .first();
    used =
      (
        await db
          .prepare("SELECT units FROM usage WHERE user_hash=? AND month=? AND task=?")
          .bind(user, month, task)
          .first()
      )?.units || 0;
    bonus = Math.max(
      0,
      (
        await db
          .prepare("SELECT granted-used AS n FROM bonus WHERE user_hash=? AND task=?")
          .bind(user, task)
          .first()
      )?.n || 0,
    );
    purchased = allowPurchased
      ? (
          await db
            .prepare(
              "SELECT COALESCE(SUM(p.available),0) AS n " +
                purchaseFrom +
                " WHERE p.user_hash=? AND " +
                purchaseSpendable,
            )
            .bind(user)
            .first()
        ).n
      : 0;
  } catch {
    throw busy();
  }
  const cap = (message) =>
    new HttpError(429, "cap", message, {
      task,
      resets: nextMonth(now),
      upgrade: canUpgrade(env, config, plan),
      tier,
      offer: upgradeOffer(env, config, tier, plan, now),
    });
  if (row && row.calls >= config.MAX_CALLS_PER_RUN) throw cap("This run reached its call limit");
  if (row && !row.generation) {
    // No insertion, source debit or legacy fallback after a funded attempt. The SQL
    // call increment itself excludes funded/deleted rows and requires a live old run.
    return {
      kind: "legacy",
      admitted: await admit(db, env, config, user, task, runId, now, tier, plan, estimate, {
        preflightDone: true,
        existingLegacyOnly: true,
      }),
    };
  }
  if (!row && mode === "drain") throw busy();
  if (limit !== null && (!(limit > 0) || (!row && used >= limit && bonus + purchased === 0))) {
    await countEvent(db, now.toISOString().slice(0, 10), "cap_hit", task);
    throw cap(`Monthly ${task} allowance is used up`);
  }
  const accountCeiling = userBudgetCents(config, env, tier, plan),
    dayBudget = dailyBudgetCents(env, config);
  if (
    accountCeiling !== null &&
    (!(accountCeiling > 0) ||
      ((
        await db
          .prepare("SELECT cents FROM spend WHERE user_hash=? AND month=?")
          .bind(user, month)
          .first()
      )?.cents || 0) >= accountCeiling)
  )
    throw cap("This account reached its monthly AI ceiling");
  if (plan === "free" && (await daySpend(db, now.toISOString().slice(0, 10))) >= dayBudget) {
    await db.batch([
      db
        .prepare("UPDATE rate SET calls=calls-1 WHERE user_hash=? AND bucket IN (?,?) AND calls>0")
        .bind(user, "m:" + now.toISOString().slice(0, 16), "d:" + now.toISOString().slice(0, 10)),
      db
        .prepare("UPDATE rate SET calls=calls-1 WHERE user_hash='*' AND bucket=? AND calls>0")
        .bind("m:" + now.toISOString().slice(0, 16)),
    ]);
    throw new HttpError(
      503,
      "paused",
      "AI features are paused until tomorrow because today's share of the budget is used up. Search still works.",
      {
        retry_after: Math.ceil(
          (Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) -
            now.getTime()) /
            1000,
        ),
      },
    );
  }
  const input = {
    userHash: user,
    task,
    runId,
    allowance: limit,
    maxCalls: config.MAX_CALLS_PER_RUN,
    estimate,
    accountCeiling,
    monthBudget: budgetCents(env, config),
    dayBudget,
    freeTier: plan === "free",
    allowPurchased,
  };
  const result = row?.generation
    ? await reserveFundedSibling(db, { ...input, month, generation: row.generation }, now)
    : await reserveFirstFundedRun(db, input, now);
  if (result.status !== "reserved") throw busy(); // Including lost acknowledgment: never retry or fallback.
  return {
    kind: "funded",
    identity: { ...input, ...result },
    limits,
    remaining:
      limit === null
        ? "unlimited"
        : Math.max(0, limit - used - (row ? 0 : 1)) +
          bonus +
          purchased -
          (row || used < limit ? 0 : 1),
  };
}

// Bounded one-attempt raw HTTP adapter; the boundary distinguishes explicit rejection
// from thrown/aborted uncertainty. No live request occurs until route admission succeeds.
export async function respondFundedAi(
  admission,
  { env, config, fetcher, model, gem, stream, now, db },
) {
  const { identity, limits } = admission;
  if (!env.GEMINI_API_KEY) {
    await releaseFundedCall(db, identity);
    throw new HttpError(500, "server", "Server is missing GEMINI_API_KEY");
  }
  const send = async () => {
    const controller = new AbortController();
    let expired = false,
      timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
        reject(Error("unavailable"));
      }, limits.deadlineMs);
    });
    try {
      const response = Promise.resolve()
        .then(() =>
          fetcher(geminiUrl(model, stream), {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
            body: JSON.stringify(gem),
            signal: controller.signal,
          }),
        )
        .then((response) => {
          if (expired) {
            void response.body?.cancel().catch(() => {});
            throw Error("unavailable");
          }
          return response;
        });
      return await Promise.race([response, timeout]);
    } finally {
      clearTimeout(timer);
    }
  };
  return fundedProviderResponse({
    db,
    identity,
    send,
    stream,
    limits,
    model,
    price: (usage) => costCents(model, usage, config, now),
    headers: {
      "X-InternScout-Model": model,
      "X-InternScout-Remaining": String(admission.remaining),
      "Content-Type": stream ? "text/event-stream" : "application/json",
      ...(stream ? { "Cache-Control": "no-cache" } : {}),
    },
  });
}
