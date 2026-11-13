// Dormant daily-cleanup building block. No scheduler, provider or purchase erasure.
import { cleanupTopupHistoryReceipts } from "./topup-history-observation.js";
const promiseThen = Promise.prototype.then;
const promiseSpecies = Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get;
function discardAsyncClock(value) {
  // Observe ordinary accidental async returns without adopting foreign thenables or
  // consulting caller-defined constructors/species. Exotic promises remain caller-owned.
  if (
    !value ||
    Object.getPrototypeOf(value) !== Promise.prototype ||
    Object.hasOwn(value, "constructor") ||
    Object.getOwnPropertyDescriptor(Promise.prototype, "constructor")?.value !== Promise ||
    Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get !== promiseSpecies
  )
    return;
  try {
    Reflect.apply(promiseThen, value, [undefined, () => {}]);
  } catch {
    /* Not a native promise. */
  }
}

function own(value, key) {
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d?.enumerable || !Object.hasOwn(d, "value")) throw new Error();
  return d.value;
}
export async function drainTopupHistoryReceipts(db, options = {}) {
  let pages = 0,
    removed = 0;
  const result = (status) => ({ status, pages, removed });
  try {
    const enabled = Object.getOwnPropertyDescriptor(options, "enabled");
    if (!enabled) return { status: "disabled" };
    if (!Object.hasOwn(enabled, "value")) throw new Error();
    if (enabled.value !== true) return { status: "disabled" };
    if (
      Reflect.ownKeys(options).sort().join(",") !== "deadlineMs,enabled,limit,maxPages,monotonicNow"
    )
      throw new Error();
    const limit = own(options, "limit"),
      maxPages = own(options, "maxPages"),
      deadlineMs = own(options, "deadlineMs"),
      clock = own(options, "monotonicNow");
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 256 ||
      !Number.isSafeInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > 256 ||
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > 60000 ||
      typeof clock !== "function"
    )
      throw new Error();
    let previous = -1;
    const sample = () => {
      const at = clock();
      if (!Number.isFinite(at) || at < 0 || at < previous || at > Number.MAX_SAFE_INTEGER) {
        discardAsyncClock(at);
        throw new Error();
      }
      previous = at;
      return at;
    };
    const deadline = sample() + deadlineMs;
    if (deadline > Number.MAX_SAFE_INTEGER) throw new Error();
    const expired = () => sample() >= deadline;
    let stoppedBeforeSubmission = false;
    const guarded = {
      prepare: (sql) => db.prepare(sql),
      batch(statements) {
        // Preparation is synchronous but can consume time. Fence the actual submission.
        const submit = db.batch;
        if (typeof submit !== "function") throw new Error();
        if (expired()) {
          stoppedBeforeSubmission = true;
          throw new Error();
        }
        pages++;
        return Reflect.apply(submit, db, [statements]);
      },
    };
    while (pages < maxPages) {
      if (expired()) return result("partial");
      const page = await cleanupTopupHistoryReceipts(guarded, { enabled: true, limit });
      if (page.status !== "cleaned")
        return result(stoppedBeforeSubmission ? "partial" : "unavailable");
      removed += page.removed;
      // An admitted late page is accounted for but cannot certify a successful daily drain.
      if (expired()) return result("partial");
      if (page.removed < limit) return result("complete");
    }
    return result("partial");
  } catch {
    return result("unavailable");
  }
}
