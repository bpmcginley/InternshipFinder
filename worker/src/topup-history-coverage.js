// Dormant metadata fencing. Advancing requires an explicit trusted provider and restore verifier.
import { consumeTopupReplayProof } from "./topup-history-replay.js";

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const FIELDS = "mode,epoch,schema_key,starts_at,covered_through,revision,health";
const SELECT = `SELECT ${FIELDS},${NOW} AS observed_at FROM topup_history_coverage`;
const status = (value) => ({ status: value });
const schema = (s) => typeof s === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(s);
const instant = (s) =>
  typeof s === "string" &&
  s.length === 24 &&
  Number.isFinite(Date.parse(s)) &&
  new Date(s).toISOString() === s;
function own(value, fields) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length
  )
    throw new Error();
  const d = Object.getOwnPropertyDescriptors(value),
    result = {};
  if (Object.keys(d).sort().join(",") !== fields.split(",").sort().join(",")) throw new Error();
  for (const [key, item] of Object.entries(d)) {
    if (!item.enumerable || !Object.hasOwn(item, "value")) throw new Error();
    result[key] = item.value;
  }
  return result;
}
function coverage(value) {
  const r = own(value, FIELDS);
  if (
    !["test", "live"].includes(r.mode) ||
    typeof r.epoch !== "string" ||
    !/^[a-f0-9]{32}$/.test(r.epoch) ||
    !schema(r.schema_key) ||
    !instant(r.starts_at) ||
    !Number.isSafeInteger(r.revision) ||
    r.revision < 1 ||
    !["unproven", "closed", "qualified"].includes(r.health) ||
    (r.covered_through !== null &&
      (!instant(r.covered_through) || r.covered_through < r.starts_at)) ||
    (r.health === "unproven" && r.covered_through !== null) ||
    (r.health === "qualified" && r.covered_through === null)
  )
    throw new Error();
  return r;
}
function receipt(rows, count) {
  if (!Array.isArray(rows) || rows.length !== count) throw new Error();
  for (let i = 0; i < count; i++) {
    const r = rows[i];
    if (
      !Object.hasOwn(rows, i) ||
      r?.success !== true ||
      !Array.isArray(r.results) ||
      !Number.isSafeInteger(r.meta?.changes) ||
      r.meta.changes < 0 ||
      r.meta.changes > 1
    )
      throw new Error();
  }
  return rows;
}
function selected(row) {
  if (row.meta.changes !== 0 || row.results.length > 1) throw new Error();
  if (!row.results.length) return null;
  if (!Object.hasOwn(row.results, 0)) throw new Error();
  const { observed_at, ...rest } = own(row.results[0], FIELDS + ",observed_at"),
    r = coverage(rest);
  if (
    !instant(observed_at) ||
    r.starts_at > observed_at ||
    (r.covered_through !== null && r.covered_through > observed_at)
  )
    throw new Error();
  return r;
}
const modeOf = (live) => {
  if (typeof live !== "boolean") throw new Error();
  return live ? "live" : "test";
};
const guard = `mode=? AND epoch=? AND schema_key=? AND starts_at=? AND covered_through IS ?
  AND revision=? AND health=? AND starts_at<=${NOW} AND (covered_through IS NULL OR covered_through<=${NOW})`;
const bindings = (r) => [
  r.mode,
  r.epoch,
  r.schema_key,
  r.starts_at,
  r.covered_through,
  r.revision,
  r.health,
];

export async function captureTopupCoverage(db, livemode, options = {}) {
  if (options?.enabled !== true) return status("disabled");
  try {
    const mode = modeOf(livemode);
    const [row] = receipt(await db.batch([db.prepare(`${SELECT} WHERE mode=?`).bind(mode)]), 1);
    const current = selected(row);
    if (current && current.mode !== mode) throw new Error();
    return current ? { status: "captured", coverage: current } : status("missing");
  } catch {
    return status("unavailable");
  }
}
async function mutate(db, statement, mode, epoch, revision, intended) {
  const rows = receipt(
    await db.batch([
      statement,
      db
        .prepare(`${SELECT} WHERE mode=? AND epoch=? AND revision=? AND changes()=1`)
        .bind(mode, epoch, revision),
    ]),
    2,
  );
  if (rows[0].results.length) throw new Error();
  const current = selected(rows[1]);
  if (!rows[0].meta.changes) {
    if (current) throw new Error();
    return status("stale");
  }
  if (!current || current.mode !== mode || current.epoch !== epoch || current.revision !== revision)
    throw new Error();
  if (Object.entries(intended).some(([key, value]) => current[key] !== value)) throw new Error();
  return { status: "committed", coverage: current };
}
// Capture before authoritative work. A fresh epoch always starts unproven, with no completed interval.
export async function rotateTopupCoverage(db, input, options = {}) {
  if (options?.enabled !== true) return status("disabled");
  try {
    const { livemode, schemaKey, expected } = own(input, "livemode,schemaKey,expected"),
      mode = modeOf(livemode);
    if (!schema(schemaKey)) throw new Error();
    const before = expected === null ? null : coverage(expected);
    if (before && (before.mode !== mode || before.revision === Number.MAX_SAFE_INTEGER))
      throw new Error();
    const epoch = crypto.randomUUID().replaceAll("-", ""),
      revision = (before?.revision ?? 0) + 1;
    const statement = before
      ? db
          .prepare(
            `UPDATE topup_history_coverage
      SET epoch=?,schema_key=?,starts_at=${NOW},covered_through=NULL,revision=revision+1,health='unproven'
      WHERE ${guard}`,
          )
          .bind(epoch, schemaKey, ...bindings(before))
      : db
          .prepare(
            `INSERT INTO topup_history_coverage(${FIELDS}) SELECT ?,?,?,${NOW},NULL,1,'unproven'
        WHERE NOT EXISTS(SELECT 1 FROM topup_history_coverage WHERE mode=?) ON CONFLICT(mode) DO NOTHING`,
          )
          .bind(mode, epoch, schemaKey, mode);
    return await mutate(db, statement, mode, epoch, revision, {
      schema_key: schemaKey,
      health: "unproven",
      covered_through: null,
    });
  } catch {
    return status("unavailable");
  }
}
const day = 86400;
const isoSecond = (value) => new Date(value * 1000).toISOString();

// Replay uses [from, to) in whole Stripe seconds. The persisted UTC bound is inclusive.
function windowBounds(before, from, to) {
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    from >= to ||
    to - from > 30 * day ||
    before.health === "closed" ||
    before.revision === Number.MAX_SAFE_INTEGER
  )
    throw new Error();
  const earliest = Math.floor(Date.parse(before.starts_at) / 1000);
  const end = new Date(to * 1000 - 1).toISOString();
  if (
    from < earliest ||
    !instant(end) ||
    end < before.starts_at ||
    (before.covered_through === null
      ? from !== earliest
      : isoSecond(from) > before.covered_through || end <= before.covered_through)
  )
    throw new Error();
  return end;
}

// Only a trusted server caller may supply the verifier, after complete bounded replay.
// It owns account identity, mode, provider completeness and restore verification.
// The exact request object binds a positive response to this invocation and DB.
export async function advanceTopupCoverage(
  db,
  replayProof,
  { verifyHistory, beforeCommit = () => true, commitBy } = {},
) {
  if (typeof verifyHistory !== "function" || typeof beforeCommit !== "function")
    return status("disabled");
  try {
    const replay = consumeTopupReplayProof(db, replayProof);
    if (!replay || !instant(commitBy)) throw new Error();
    const { expected, from, to, ...scope } = replay;
    const before = coverage(expected);
    const end = windowBounds(before, from, to);
    const request = Object.freeze({ coverage: Object.freeze(before), from, to, ...scope });
    const result = own(await verifyHistory(db, request), "status,request");
    if (result.request !== request || beforeCommit() !== true) return status("unproven");
    if (result.status === "fault") return status("fault");
    if (result.status !== "verified") return status("unproven");
    return await mutate(
      db,
      db
        .prepare(
          `UPDATE topup_history_coverage
      SET covered_through=?,health='qualified',revision=revision+1
      WHERE ${guard} AND ?<=${NOW} AND ${NOW}<?`,
        )
        .bind(end, ...bindings(before), end, commitBy),
      before.mode,
      before.epoch,
      before.revision + 1,
      {
        schema_key: before.schema_key,
        health: "qualified",
        starts_at: before.starts_at,
        covered_through: end,
      },
    );
  } catch {
    return status("unavailable");
  }
}

// Closure preserves the last known bounds but invalidates every old revision. It cannot qualify a gap.
export async function closeTopupCoverage(db, expected, options = {}) {
  if (options?.enabled !== true) return status("disabled");
  try {
    const before = coverage(expected);
    if (before.revision === Number.MAX_SAFE_INTEGER) throw new Error();
    return await mutate(
      db,
      db
        .prepare(
          `UPDATE topup_history_coverage SET health='closed',revision=revision+1
      WHERE ${guard}`,
        )
        .bind(...bindings(before)),
      before.mode,
      before.epoch,
      before.revision + 1,
      {
        schema_key: before.schema_key,
        health: "closed",
        starts_at: before.starts_at,
        covered_through: before.covered_through,
      },
    );
  } catch {
    return status("unavailable");
  }
}
