import { DurableObject } from "cloudflare:workers";

const PENDING_MS = 86_400_000;
const ACCEPTED_MS = 7 * PENDING_MS;
const ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SHA = /^[a-f0-9]{64}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

function invalid() {
  return new TypeError("invalid follow checkpoint input");
}

function identity(commit, tree, digest) {
  if (typeof commit !== "string" || !ID.test(commit) || typeof tree !== "string"
    || !ID.test(tree) || commit.length !== tree.length
    || (digest !== null && (typeof digest !== "string" || !SHA.test(digest)))) throw invalid();
  return `${commit}:${tree}:${digest ?? ""}`;
}

function instant(raw) {
  if (typeof raw !== "string" || !UTC.test(raw)) throw invalid();
  const aligned = raw.slice(0, -4) + "Z";
  const floor = Date.parse(aligned);
  if (!Number.isSafeInteger(floor) || new Date(floor).toISOString() !== aligned) throw invalid();
  return { stamp: raw, floor, ceil: floor + (raw.slice(-4, -1) === "000" ? 0 : 1) };
}

function bound(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw invalid();
}

async function record(body, maxBytes, slot) {
  bound(maxBytes);
  if (!(body instanceof ArrayBuffer) || body.byteLength === 0 || body.byteLength > maxBytes) throw invalid();
  const bytes = body.slice(0);
  let value;
  try {
    value = JSON.parse(decoder.decode(bytes));
  } catch {
    throw invalid();
  }
  if (!value || value.version !== 1 || !Array.isArray(value.rows)) throw invalid();
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (slot === "pending") {
    const previous = value.predecessor;
    if (!previous) throw invalid();
    const prior = identity(previous.commit, previous.public_tree, previous.checkpoint_sha256);
    identity(value.candidate_commit, value.candidate_tree, null);
    const target = identity(value.candidate_commit, value.public_tree, null);
    const at = instant(value.prepared_at);
    return {
      bytes, digest, target, prior,
      seed: previous.checkpoint_sha256 === null,
      stamp: at.stamp,
      starts: at.ceil,
      expires: at.floor + PENDING_MS,
    };
  }
  const target = identity(value.accepted_commit, value.public_tree, null);
  const at = instant(value.accepted_at);
  return { bytes, digest, target, stamp: at.stamp, starts: at.ceil, expires: at.floor + ACCEPTED_MS };
}

/** Detached storage for trusted, already verified Python checkpoints. No HTTP entrypoint. */
export class FollowCheckpoint extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS checkpoint (
      slot TEXT PRIMARY KEY CHECK (slot IN ('pending', 'accepted')),
      target TEXT NOT NULL,
      digest TEXT NOT NULL,
      prior TEXT NOT NULL,
      seed INTEGER NOT NULL,
      stamp TEXT NOT NULL,
      starts INTEGER NOT NULL,
      expires INTEGER NOT NULL,
      promoted TEXT,
      body BLOB NOT NULL
    )`);
  }

  async #change(operation) {
    const storage = this.ctx.storage;
    const sql = storage.sql;
    return storage.transaction(async () => {
      const [result, next] = storage.transactionSync(() => {
        const { now } = sql.exec(
          "SELECT CAST(ROUND(unixepoch('subsec') * 1000) AS INTEGER) AS now",
        ).one();
        if (!Number.isSafeInteger(now)) throw new Error("follow checkpoint clock unavailable");
        sql.exec("DELETE FROM checkpoint WHERE expires <= ?", now);
        const result = operation(sql, now);
        const { next } = sql.exec("SELECT MIN(expires) AS next FROM checkpoint").one();
        return [result, next];
      });
      if (next === null) await storage.deleteAlarm();
      else await storage.setAlarm(next);
      return result;
    });
  }

  async read(maxBytes) {
    bound(maxBytes);
    return this.#change((sql, now) => {
      const rows = sql.exec("SELECT slot, length(body) AS size FROM checkpoint WHERE starts <= ?", now).toArray();
      if (rows.some((row) => row.size > maxBytes)) throw invalid();
      return Object.fromEntries(rows.map(({ slot }) =>
        [slot, sql.exec("SELECT body FROM checkpoint WHERE slot = ?", slot).one().body]));
    });
  }

  async reservePending(body, maxBytes) {
    const pending = await record(body, maxBytes, "pending");
    return this.#change((sql, now) => {
      if (now < pending.starts || now >= pending.expires) return "stale";
      const accepted = slot(sql, "accepted");
      if (!matchesPredecessor(accepted, pending, now)) return "stale";
      const current = slot(sql, "pending");
      if (current) return current.digest === pending.digest ? "already_pending" : "stale";
      put(sql, "pending", pending, pending.prior, null);
      return "pending";
    });
  }

  async promote(body, maxBytes, options) {
    const { predecessor, generation, checkedAt } = options ?? {};
    if (!predecessor || typeof generation !== "string" || !SHA.test(generation)) throw invalid();
    const prior = identity(predecessor.commit, predecessor.public_tree, predecessor.checkpoint_sha256);
    const checked = instant(checkedAt);
    const accepted = await record(body, maxBytes, "accepted");
    return this.#change((sql, now) => {
      if (checked.stamp < accepted.stamp || now < checked.ceil
        || now < accepted.starts || now >= accepted.expires) return "stale";
      const current = slot(sql, "accepted");
      if (current?.promoted === generation && current.target === accepted.target && current.prior === prior) {
        return current.starts <= now ? "already_promoted" : "stale";
      }
      const pending = slot(sql, "pending");
      if (pending?.digest !== generation || pending.prior !== prior || pending.starts > now
        || accepted.stamp < pending.stamp || !matchesPredecessor(current, pending, now)
        || pending.target.split(":")[1] !== accepted.target.split(":")[1]) return "stale";
      put(sql, "accepted", accepted, prior, generation);
      if (sql.exec("DELETE FROM checkpoint WHERE slot = 'pending' AND digest = ?", generation).rowsWritten !== 1) {
        throw new Error("follow checkpoint promotion could not clear pending");
      }
      return "promoted";
    });
  }

  async rejectPending(generation) {
    if (typeof generation !== "string" || !SHA.test(generation)) throw invalid();
    return this.#change((sql) =>
      sql.exec("DELETE FROM checkpoint WHERE slot = 'pending' AND digest = ?", generation).rowsWritten === 1);
  }

  async alarm() {
    await this.#change(() => {});
  }
}

function slot(sql, name) {
  return sql.exec(
    "SELECT target, digest, prior, seed, stamp, starts, promoted FROM checkpoint WHERE slot = ?",
    name,
  ).toArray()[0];
}

function matchesPredecessor(accepted, pending, now) {
  return accepted
    ? accepted.starts <= now && accepted.target + accepted.digest === pending.prior
    : Boolean(pending.seed);
}

function put(sql, slotName, entry, prior, generation) {
  sql.exec(
    `INSERT OR REPLACE INTO checkpoint
      (slot, target, digest, prior, seed, stamp, starts, expires, promoted, body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    slotName, entry.target, entry.digest, prior, Number(Boolean(entry.seed)),
    entry.stamp, entry.starts, entry.expires, generation, entry.bytes,
  );
}
