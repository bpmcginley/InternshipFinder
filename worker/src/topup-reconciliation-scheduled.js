// Internal scheduler. The host owns trigger selection and durable per-mode cursor storage.
import { recoverTopupPurchase } from "./topup-purchase-recovery.js";
import { PAYMENT_EVIDENCE_BOUNDS } from "./topup-payment-evidence.js";
import { REVERSAL_BOUNDS } from "./topup-reversal-evidence.js";
import { historicalTopupOffer, topupRecoveryConfigured } from "./topup-stripe.js";

const MAX_PURCHASES = 16;
const MAX_REQUESTS = 45;
const MAX_DEADLINE_MS = 60_000;
const PURCHASE_REQUESTS = PAYMENT_EVIDENCE_BOUNDS.requests + REVERSAL_BOUNDS.requests;
const hash = /^[a-f0-9]{64}$/;
const promiseThen = Promise.prototype.then;
const promiseSpecies = Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get;
const fail = () => {
  throw Error("Unavailable top-up reconciliation");
};

function data(value, key) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) fail();
  return descriptor.value;
}
function fields(value, keys) {
  if (
    !value ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).sort().join(",") !== keys
  )
    fail();
}
const boundedInteger = (n, min, max) => Number.isSafeInteger(n) && n >= min && n <= max;

function cursorState(value) {
  fields(value, "after,revision");
  const after = data(value, "after"),
    revision = data(value, "revision");
  if (
    (after !== "" && (typeof after !== "string" || !hash.test(after))) ||
    !boundedInteger(revision, 0, Number.MAX_SAFE_INTEGER)
  )
    fail();
  return Object.freeze({ after, revision });
}

// The cursor port returns the committed tuple from the same durable CAS as the write.
// Expired or uncertain acknowledgement stops the invocation without retrying the write.
export async function runTopupReconciliationScheduled(eventCron, descriptor = {}, context) {
  let attempted = 0,
    applied = 0,
    pending = 0,
    requests = 0,
    timer;
  const result = (status) => ({ status, attempted, applied, pending, requests });
  const controller = new AbortController();

  try {
    const enabled = Object.getOwnPropertyDescriptor(descriptor, "enabled");
    if (!enabled) return { status: "disabled" };
    if (data(descriptor, "enabled") !== true) return { status: "disabled" };
    fields(descriptor, "cron,deadlineMs,enabled,limit,livemode,maxRequests");
    const cron = data(descriptor, "cron");
    // Future production composition must validate platform syntax and semantic cron conflicts.
    if (
      typeof cron !== "string" ||
      cron.length > 128 ||
      !/^[0-9*/,-]+(?: [0-9*/,-]+){4}$/.test(cron)
    )
      fail();
    if (eventCron !== cron) return { status: "disabled" };
    const deadlineMs = data(descriptor, "deadlineMs"),
      limit = data(descriptor, "limit"),
      livemode = data(descriptor, "livemode"),
      maxRequests = data(descriptor, "maxRequests");
    if (
      !boundedInteger(deadlineMs, 1, MAX_DEADLINE_MS) ||
      !boundedInteger(limit, 1, MAX_PURCHASES) ||
      !boundedInteger(maxRequests, PURCHASE_REQUESTS, MAX_REQUESTS) ||
      typeof livemode !== "boolean"
    )
      fail();

    fields(context, "cursor,db,env,fetch,monotonicNow");
    const clock = data(context, "monotonicNow"),
      readProvider = data(context, "fetch");
    if (typeof clock !== "function" || typeof readProvider !== "function") fail();
    let last = -1;
    const sample = () => {
      const at = clock();
      if (!Number.isFinite(at) || at < last || at < 0 || at > Number.MAX_SAFE_INTEGER) {
        // The trusted synchronous clock owns foreign thenables; observe native rejections.
        if (
          at &&
          Object.getPrototypeOf(at) === Promise.prototype &&
          !Object.hasOwn(at, "constructor") &&
          Object.getOwnPropertyDescriptor(Promise.prototype, "constructor")?.value === Promise &&
          Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get === promiseSpecies
        )
          Reflect.apply(promiseThen, at, [undefined, () => {}]);
        fail();
      }
      return (last = at);
    };
    const start = sample(),
      wallStart = performance.now();
    const live = () => {
      if (
        controller.signal.aborted ||
        sample() - start >= deadlineMs ||
        performance.now() - wallStart >= deadlineMs
      ) {
        controller.abort();
        fail();
      }
    };

    const db = data(context, "db"),
      cursor = data(context, "cursor"),
      env = data(context, "env");
    const config = Object.freeze({
      STRIPE_SECRET_KEY: env?.STRIPE_SECRET_KEY,
      STRIPE_PRICE_TOPUP: env?.STRIPE_PRICE_TOPUP,
    });
    if (
      typeof db?.prepare !== "function" ||
      typeof db.batch !== "function" ||
      typeof cursor?.read !== "function" ||
      typeof cursor.advance !== "function" ||
      !topupRecoveryConfigured(config)
    )
      fail();

    const guardedDb = {
      prepare(sql) {
        live();
        return db.prepare(sql);
      },
      batch(statements) {
        live();
        // The existing revision CAS still fences any mutation admitted before cutoff.
        return db.batch(statements);
      },
    };
    const fetch = async (url, init) => {
      live();
      if (
        requests >= maxRequests ||
        typeof url !== "string" ||
        new URL(url).origin !== "https://api.stripe.com" ||
        init?.method !== "GET" ||
        init.body != null ||
        init.redirect !== "manual"
      )
        fail();
      requests++;
      const signal = init.signal
        ? AbortSignal.any([controller.signal, init.signal])
        : controller.signal;
      const response = await readProvider(url, { ...init, signal });
      try {
        live();
        return response;
      } catch {
        try {
          void response?.body?.cancel().catch(() => {});
        } catch {
          /* Cancellation is best effort. */
        }
        fail();
      }
    };

    const run = async () => {
      live();
      let state = cursorState(await cursor.read(livemode));
      live();
      const page = await db
        .prepare(
          "SELECT payment_hash,offer_version FROM topup_purchases WHERE payment_hash>? " +
            "ORDER BY payment_hash LIMIT ?",
        )
        .bind(state.after, limit)
        .all();
      live();
      if (data(page, "success") !== true) fail();
      const rows = data(page, "results");
      if (!Array.isArray(rows) || rows.length > limit) fail();
      let lastHash = state.after;
      const entries = Array.from({ length: rows.length }, (_, index) => {
        const row = data(rows, String(index));
        fields(row, "offer_version,payment_hash");
        const paymentHash = data(row, "payment_hash"),
          version = data(row, "offer_version");
        if (
          typeof paymentHash !== "string" ||
          !hash.test(paymentHash) ||
          paymentHash <= lastHash ||
          typeof version !== "string"
        )
          fail();
        lastHash = paymentHash;
        return { paymentHash, version };
      });

      const advance = async (after) => {
        live();
        if (state.revision === Number.MAX_SAFE_INTEGER) fail();
        const next = Object.freeze({ after, revision: state.revision + 1 });
        // Reserve each item before external reads. A missed item remains in the next rotation.
        const receipt = await cursor.advance(livemode, state, next);
        live();
        if (receipt === null) return false; // Rejected CAS. Never resubmit it.
        const committed = cursorState(receipt);
        if (committed.after !== next.after || committed.revision !== next.revision) fail();
        state = committed;
        return true;
      };
      if (!entries.length) {
        if (!state.after) return result("complete");
        return result((await advance("")) ? "wrapped" : "held");
      }

      for (const { paymentHash, version } of entries) {
        live();
        if (maxRequests - requests < PURCHASE_REQUESTS) return result("partial");
        if (!(await advance(paymentHash))) return result("held");
        attempted++;
        const offer = historicalTopupOffer(config, version, livemode);
        if (!offer) {
          pending++;
          continue;
        }
        try {
          const refreshed = await recoverTopupPurchase(
            guardedDb,
            config,
            paymentHash,
            offer,
            fetch,
          );
          live();
          if (refreshed.status === "applied") applied++;
          else pending++;
        } catch {
          // An unavailable record cannot block neighboring purchases. The existing CAS
          // prevents resubmitting an uncertain financial result in this invocation.
          live();
          pending++;
        }
      }
      return result("complete");
    };

    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(result("partial"));
      }, deadlineMs);
    });
    return await Promise.race([run(), timeout]);
  } catch {
    return result(controller.signal.aborted ? "partial" : "held");
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
