// Private singleton CAS primitives. No runtime initialization, reset or lease reclaim.
const tickets = new WeakMap();
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const unavailable = () => ({ status: "unavailable" });
const fail = () => {
  throw new Error("Follow owner unavailable");
};
function exact(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length
  )
    fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== keys.length) fail();
  for (const key of keys)
    if (!descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], "value")) fail();
  return value;
}
function cursor(value) {
  if (value === null) return null;
  exact(value, ["id", "expires_at"]);
  if (
    typeof value.id !== "string" ||
    !UUID.test(value.id) ||
    typeof value.expires_at !== "string" ||
    value.expires_at.length !== 24 ||
    !Number.isFinite(Date.parse(value.expires_at)) ||
    new Date(value.expires_at).toISOString() !== value.expires_at
  )
    fail();
  return { id: value.id, expires_at: value.expires_at };
}
function continuation(value) {
  exact(value, ["confirmation", "management", "nextKind"]);
  if (!["confirmation", "management"].includes(value.nextKind)) fail();
  return {
    confirmation: cursor(value.confirmation),
    management: cursor(value.management),
    nextKind: value.nextKind,
  };
}
function owner(row) {
  exact(row, [
    "singleton",
    "version",
    "generation",
    "phase",
    "next_kind",
    "confirmation_id",
    "confirmation_expires_at",
    "management_id",
    "management_expires_at",
  ]);
  if (
    row.singleton !== 1 ||
    row.version !== 1 ||
    typeof row.generation !== "string" ||
    !/^[0-9a-f]{32}$/.test(row.generation) ||
    !["ready", "running", "held"].includes(row.phase)
  )
    fail();
  const read = (kind) => {
    const id = row[`${kind}_id`],
      expires_at = row[`${kind}_expires_at`];
    if (id === null && expires_at === null) return null;
    return cursor({ id, expires_at });
  };
  return continuation({
    confirmation: read("confirmation"),
    management: read("management"),
    nextKind: row.next_kind,
  });
}
const changed = (r) =>
  r?.success === true &&
  Array.isArray(r.results) &&
  r.results.length === 0 &&
  r.meta?.changes === 1;
function selected(r) {
  if (
    r?.success !== true ||
    r.meta?.changes !== 0 ||
    !Array.isArray(r.results) ||
    r.results.length !== 1
  )
    fail();
  return r.results[0];
}
// Acquisition only reads one row and changes one row in a D1 transaction.
export async function acquireFollowDeliveryOwner(db, beforeAcquire, ownerExpiresAtMs) {
  try {
    if (beforeAcquire !== undefined && typeof beforeAcquire !== "function") fail();
    if (
      ownerExpiresAtMs !== undefined &&
      (!Number.isSafeInteger(ownerExpiresAtMs) || ownerExpiresAtMs <= 0)
    )
      fail();
    const before = await db
      .prepare("SELECT * FROM follow_delivery_owner WHERE singleton=1")
      .first();
    owner(before);
    if (before.phase !== "ready") return { status: "held" };
    const generation = crypto.randomUUID().replaceAll("-", "");
    const update =
      "UPDATE follow_delivery_owner SET phase='running',generation=? WHERE singleton=1 AND version=1 AND phase='ready' AND generation=?";
    // Same millisecond UTC expression as 0025. Omission preserves the exact legacy query.
    const bounded = ownerExpiresAtMs !== undefined;
    const statements = [
      db
        .prepare(
          bounded
            ? `${update} AND ?>CAST(round((julianday('now')-2440587.5)*86400000) AS INTEGER)`
            : update,
        )
        .bind(
          ...(bounded
            ? [generation, before.generation, ownerExpiresAtMs]
            : [generation, before.generation]),
        ),
      db
        .prepare(
          "SELECT * FROM follow_delivery_owner WHERE singleton=1 AND version=1 AND phase='running' AND generation=?",
        )
        .bind(generation),
    ];
    // Optional trusted synchronous admission fence; never race already-submitted D1 work.
    if (beforeAcquire !== undefined) {
      const admitted = beforeAcquire();
      if (admitted !== true) {
        void Promise.resolve(admitted).catch(() => {});
        fail();
      }
    }
    const rows = await db.batch(statements);
    if (!Array.isArray(rows) || rows.length !== 2 || !changed(rows[0])) return unavailable();
    const row = selected(rows[1]);
    const resume = owner(row);
    if (row.generation !== generation || row.phase !== "running") fail();
    // Logical expiry uses DB time, never the caller's clock. Validate stored values first.
    for (const kind of ["confirmation", "management"]) {
      if (resume[kind]) {
        const present = await db
          .prepare(
            `SELECT 1 AS present FROM follow_${kind}_outbox WHERE id=? AND expires_at=? AND expires_at>${NOW}`,
          )
          .bind(resume[kind].id, resume[kind].expires_at)
          .first("present");
        if (present === null) resume[kind] = null;
        else if (present !== 1) fail();
      }
    }
    const ticket = Object.freeze(Object.create(null));
    tickets.set(ticket, { db, generation });
    return { status: "acquired", ticket, continuation: resume };
  } catch {
    return unavailable();
  }
}
function clean(result, maxCandidates, maxExpired) {
  if (result?.status === "maintained") exact(result, ["status", "cleanup"]);
  else exact(result, ["status", "cleanup", "dispatch"]);
  const cleanup = exact(result.cleanup, ["status", "removed"]);
  if (
    cleanup.status !== "maintained" ||
    !Number.isSafeInteger(cleanup.removed) ||
    cleanup.removed < 0 ||
    cleanup.removed > maxExpired
  )
    fail();
  if (result.status === "maintained") return null;
  const dispatch = exact(result.dispatch, ["status", "counts", "continuation"]);
  if (!["processed", "paused"].includes(result.status) || dispatch.status !== result.status) fail();
  const c = exact(dispatch.counts, ["examined", "accepted", "uncertain", "unavailable", "skipped"]);
  for (const n of Object.values(c))
    if (!Number.isSafeInteger(n) || n < 0 || n > maxCandidates) fail();
  const remaining = c.examined - c.accepted - c.skipped;
  if (
    c.uncertain !== 0 ||
    c.unavailable !== 0 ||
    remaining < 0 ||
    remaining > (result.status === "paused" ? 1 : 0)
  )
    fail();
  return continuation(dispatch.continuation);
}
export async function finishFollowDeliveryOwner(
  ticket,
  result,
  { maxCandidates, maxExpired } = {},
) {
  return finishOwner(ticket, () => {
    if (
      !Number.isSafeInteger(maxCandidates) ||
      maxCandidates < 1 ||
      maxCandidates > 64 ||
      !Number.isSafeInteger(maxExpired) ||
      maxExpired < 1
    )
      fail();
    return clean(result, maxCandidates, maxExpired);
  });
}
// The one-candidate digest tick has no durable cursor. Release only on a complete,
// unambiguous receipt, without rewriting link continuation or concurrent redactions.
export async function finishFollowDigestOwner(ticket, result) {
  return finishOwner(ticket, () => {
    exact(result, ["status", "counts"]);
    if (!["processed", "paused"].includes(result.status)) fail();
    const c = result.counts;
    if (!c || ![Object.prototype, null].includes(Object.getPrototypeOf(c))) fail();
    const key =
      result.status === "paused"
        ? "paused"
        : Object.getOwnPropertyNames(c || {}).length
          ? "accepted"
          : null;
    exact(c, key === null ? [] : [key]);
    if (key !== null && Object.getOwnPropertyDescriptor(c, key).value !== 1) fail();
    return null;
  });
}
async function finishOwner(ticket, validate) {
  const owned = tickets.get(ticket);
  tickets.delete(ticket); // One acknowledged invocation, including lost-write acknowledgements.
  if (!owned) return unavailable();
  const { db, generation } = owned;
  let resume;
  try {
    resume = validate();
  } catch {
    try {
      await db
        .prepare(
          "UPDATE follow_delivery_owner SET phase='held' WHERE singleton=1 AND version=1 AND phase='running' AND generation=?",
        )
        .bind(generation)
        .run();
    } catch {
      /* Running is also closed. */
    }
    return { status: "held" };
  }
  try {
    let query, args;
    if (resume === null) {
      // No cursor update. Preserve concurrent redactions and next_kind.
      query =
        "UPDATE follow_delivery_owner SET phase='ready' WHERE singleton=1 AND version=1 AND phase='running' AND generation=?";
      args = [generation];
    } else {
      const sets = [],
        values = [];
      for (const kind of ["confirmation", "management"]) {
        const value = resume[kind];
        for (const column of ["id", "expires_at"]) {
          sets.push(
            `${kind}_${column}=CASE WHEN EXISTS(SELECT 1 FROM follow_${kind}_outbox WHERE id=? AND expires_at=? AND expires_at>${NOW}) THEN ? ELSE NULL END`,
          );
          values.push(value?.id ?? null, value?.expires_at ?? null, value?.[column] ?? null);
        }
      }
      query = `UPDATE follow_delivery_owner SET phase='ready',next_kind=?,${sets.join(",")} WHERE singleton=1 AND version=1 AND phase='running' AND generation=?`;
      args = [resume.nextKind, ...values, generation];
    }
    const receipt = await db
      .prepare(query)
      .bind(...args)
      .run();
    return changed(receipt) ? { status: "ready" } : unavailable();
  } catch {
    // The ready CAS may have committed. Never compensate or retry after an ambiguous receipt.
    return unavailable();
  }
}
