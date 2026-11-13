// Dormant scheduled port. The host owns complete cron exclusions and invocation selection.
import { drainTopupHistoryReceipts } from "./topup-history-drain.js";
const unavailable = () => ({ status: "unavailable", pages: 0, removed: 0 });
const then = Promise.prototype.then;
const species = Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get;
function discard(value) {
  if (
    !value ||
    Object.getPrototypeOf(value) !== Promise.prototype ||
    Object.hasOwn(value, "constructor") ||
    Object.getOwnPropertyDescriptor(Promise.prototype, "constructor")?.value !== Promise ||
    Object.getOwnPropertyDescriptor(Promise, Symbol.species)?.get !== species
  )
    return;
  try {
    Reflect.apply(then, value, [undefined, () => {}]);
  } catch {
    /* Not an ordinary native promise. */
  }
}
function rejectPromiseBinding(value) {
  let prototype = Object.getPrototypeOf(value);
  for (let depth = 0; depth < 16; depth++) {
    if (prototype === null) return;
    if (prototype === Promise.prototype) {
      discard(value);
      throw new Error();
    }
    prototype = Object.getPrototypeOf(prototype);
  }
  // Unverifiable deep prototype chains hold; no constructor/then/species is consulted.
  throw new Error();
}
function data(value, key) {
  const d = Object.getOwnPropertyDescriptor(value, key);
  if (!d?.enumerable || !Object.hasOwn(d, "value")) throw new Error();
  return d.value;
}
function record(value, keys) {
  if (
    !value ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).sort().join(",") !== keys
  )
    throw new Error();
}
function values(field, max) {
  if (field === "*") return new Set(Array.from({ length: max + 1 }, (_, i) => i));
  const out = new Set();
  for (const item of field.split(",")) {
    if (!/^(?:0|[1-9][0-9]?)(?:-(?:0|[1-9][0-9]?))?$/.test(item)) throw new Error();
    const [start, stop = start] = item.split("-").map(Number);
    if (start > stop || stop > max) throw new Error();
    for (let n = start; n <= stop; n++) out.add(n);
  }
  return out;
}
function conflicts(cron, minute, hour) {
  if (typeof cron !== "string" || cron.length > 128) throw new Error();
  const parts = cron.split(" ");
  // The known deployed forms are fixed/list minutes and fixed/wildcard hours. Ranges
  // are also finite. Steps, named/calendar forms or other syntax hold conservatively.
  if (parts.length !== 5 || parts.slice(2).some((v) => v !== "*")) throw new Error();
  const minutes = values(parts[0], 59),
    hours = values(parts[1], 23);
  return minutes.has(minute) && hours.has(hour);
}
export async function runTopupHistoryScheduled(eventCron, descriptor = {}, context) {
  try {
    const enabled = Object.getOwnPropertyDescriptor(descriptor, "enabled");
    if (!enabled) return { status: "disabled" };
    if (!Object.hasOwn(enabled, "value")) return unavailable();
    if (enabled.value !== true) return { status: "disabled" };
    if (!enabled.enumerable) return unavailable();
    record(descriptor, "cron,deadlineMs,enabled,limit,maxPages");
    const cron = data(descriptor, "cron");
    if (
      typeof cron !== "string" ||
      !/^(?:[0-9]|[1-5][0-9]) (?:[0-9]|1[0-9]|2[0-3]) \* \* \*$/.test(cron)
    )
      return unavailable();
    if (eventCron !== cron) return { status: "disabled" };
    const limit = data(descriptor, "limit"),
      maxPages = data(descriptor, "maxPages"),
      deadlineMs = data(descriptor, "deadlineMs");
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 256 ||
      !Number.isSafeInteger(maxPages) ||
      maxPages < 1 ||
      maxPages > 48 ||
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > 60000
    )
      return unavailable();
    record(context, "excludedCrons,getDb,monotonicNow");
    const excluded = data(context, "excludedCrons"),
      getDb = data(context, "getDb"),
      clock = data(context, "monotonicNow");
    if (
      typeof getDb !== "function" ||
      typeof clock !== "function" ||
      !Array.isArray(excluded) ||
      Object.getPrototypeOf(excluded) !== Array.prototype
    )
      return unavailable();
    const length = Object.getOwnPropertyDescriptor(excluded, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 1 || length > 16) return unavailable();
    const [minute, hour] = cron.split(" ").map(Number);
    for (let i = 0; i < length; i++)
      if (conflicts(data(excluded, String(i)), minute, hour)) return unavailable();
    let db, prepare, submit;
    const lazy = {
      prepare(sql) {
        if (!db) {
          db = getDb();
          if (!db) throw new Error();
          rejectPromiseBinding(db);
          prepare = db.prepare;
          submit = db.batch;
          if (typeof prepare !== "function" || typeof submit !== "function") {
            discard(db);
            throw new Error();
          }
        }
        return Reflect.apply(prepare, db, [sql]);
      },
      batch(statements) {
        return Reflect.apply(submit, db, [statements]);
      },
    };
    // Database resolution occurs inside drain preparation, after its sole budget starts.
    return await drainTopupHistoryReceipts(lazy, {
      enabled: true,
      limit,
      maxPages,
      deadlineMs,
      monotonicNow: clock,
    });
  } catch {
    return unavailable();
  }
}
