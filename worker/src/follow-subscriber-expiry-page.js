import { expiryReceipts } from "./follow-expiry-page.js";

const { record, rowid, dense, receipt } = expiryReceipts;
const unavailable = () => ({ status: "unavailable" });
const fail = () => {
  throw Error("Follow retention unavailable");
};

function page(db, o, kind, table, limit) {
  const { maxRows } = o,
    cursor = o.cursor ?? null;
  if (
    !Number.isSafeInteger(maxRows) ||
    maxRows < 1 ||
    maxRows > limit ||
    Object.keys(o).some(
      (k) =>
        !["enabled", "maxRows", "cursor", ...(kind === "orphans" ? ["maxChildren"] : [])].includes(
          k,
        ),
    )
  )
    fail();
  let after = null,
    through = null;
  if (cursor !== null) {
    const c = record(cursor);
    if (Object.keys(c).sort().join() !== "after,kind,through" || c.kind !== kind) fail();
    const high = rowid(c.through);
    if (c.after === null ? kind !== "orphans" : rowid(c.after) > high) fail();
    ({ after, through } = c);
  }
  const seek =
    cursor === null
      ? `rowid<=(SELECT max(rowid) FROM ${table})`
      : after === null
        ? "rowid<=CAST(? AS INTEGER)"
        : "rowid>CAST(? AS INTEGER) AND rowid<=CAST(? AS INTEGER)";
  const args =
    cursor === null ? [maxRows] : after === null ? [through, maxRows] : [after, through, maxRows];
  const query = `SELECT rowid FROM ${table} WHERE ${seek} ORDER BY rowid LIMIT ?`;
  const selected = `rowid IN (${query})`;
  const initial = [
    cursor === null
      ? db.prepare(`SELECT CAST(max(rowid) AS TEXT) AS ceiling FROM ${table}`)
      : db.prepare("SELECT ? AS ceiling").bind(through),
    db
      .prepare(`SELECT count(*) AS examined,CAST(max(rowid) AS TEXT) AS last FROM (${query})`)
      .bind(...args),
  ];
  const validate = ([upper, read]) => {
    if (
      upper.changes !== 0 ||
      upper.rows.length !== 1 ||
      read.changes !== 0 ||
      read.rows.length !== 1
    )
      fail();
    const bound = record(upper.rows[0]);
    if (Object.keys(bound).join() !== "ceiling" || (through !== null && bound.ceiling !== through))
      fail();
    through = bound.ceiling;
    const high = through === null ? null : rowid(through);
    const snapshot = record(read.rows[0]),
      { examined, last } = snapshot;
    if (
      Object.keys(snapshot).sort().join() !== "examined,last" ||
      !Number.isSafeInteger(examined) ||
      examined < 0 ||
      examined > maxRows
    )
      fail();
    const previous = last === null ? null : rowid(last);
    if (
      (examined === 0) !== (previous === null) ||
      (previous !== null &&
        (high === null || previous > high || (after !== null && previous <= rowid(after)))) ||
      (cursor === null &&
        high !== null &&
        (examined === 0 || (examined < maxRows && previous !== high)))
    )
      fail();
    return {
      examined,
      finishCandidate: (candidate, preceding, draining) => {
        const key = rowid(candidate),
          before = preceding === null ? null : rowid(preceding);
        if (
          !examined ||
          previous === null ||
          key > previous ||
          (after !== null && key <= rowid(after)) ||
          (before !== null && (before >= key || (after !== null && before <= rowid(after)))) ||
          (examined === 1 && (key !== previous || before !== null)) ||
          (examined > 1 && key === previous && before === null) ||
          (examined < 3 && before !== null && key !== previous)
        )
          fail();
        const complete = !draining && key === high;
        return {
          complete,
          next: complete ? null : { kind, after: draining ? after : candidate, through },
        };
      },
      finish: (draining = false) => {
        if (draining) {
          if (examined !== 1 || through === null) fail();
          return { complete: false, next: { kind, after, through } };
        }
        const complete = examined < maxRows || previous === high;
        return { complete, next: complete ? null : { kind, after: previous.toString(), through } };
      },
    };
  };
  return { args, selected, initial, validate };
}

function changed(write, counter, limit, multiplier) {
  if (write.rows.length || counter.changes !== 0 || counter.rows.length !== 1) fail();
  const value = record(counter.rows[0]),
    n = value.changed;
  if (
    Object.keys(value).join() !== "changed" ||
    !Number.isSafeInteger(n) ||
    n < 0 ||
    n > limit ||
    write.changes < n ||
    write.changes > n * multiplier
  )
    fail();
  return n;
}

// Stale confirmation tokens must be drained by the existing token pass first.
export async function expireFollowUnconfirmedPage(db, options = {}) {
  try {
    const o = record(options);
    if (o.enabled !== true) return { status: "disabled" };
    const p = page(db, o, "unconfirmed", "follow_subscriptions", 128);
    const raw = dense(
      await db.batch([
        ...p.initial,
        db
          .prepare(
            `DELETE FROM follow_subscriptions NOT INDEXED WHERE ${p.selected}
        AND confirmed_at IS NULL AND created<=strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')
        AND NOT EXISTS(SELECT 1 FROM follow_tokens t WHERE t.subscriber_id=follow_subscriptions.subscriber_id
          AND t.purpose='confirm' AND t.scope_key=follow_subscriptions.scope_key)`,
          )
          .bind(...p.args),
        db.prepare("SELECT changes() AS changed"),
      ]),
      4,
    );
    if (raw.length !== 4) fail();
    const r = raw.map(receipt),
      snapshot = p.validate(r);
    // One progress row, one confirmation job and at most one owner redaction per scope.
    const removed = changed(r[2], r[3], snapshot.examined, 4);
    return { status: "maintained", examined: snapshot.examined, removed, ...snapshot.finish() };
  } catch {
    return unavailable();
  }
}

// Orphan criteria are unchanged: no scopes. Child drainage bounds the former root cascade.
export async function expireFollowOrphanPage(db, options = {}) {
  try {
    const o = record(options);
    if (o.enabled !== true) return { status: "disabled" };
    const { maxChildren } = o;
    if (!Number.isSafeInteger(maxChildren) || maxChildren < 1 || maxChildren > 128) fail();
    const p = page(db, o, "orphans", "follow_subscribers", 128);
    const absent = (subscriber) =>
      `NOT EXISTS(SELECT 1 FROM follow_subscriptions s WHERE s.subscriber_id=${subscriber})`;
    const lookahead = o.maxRows > 1;
    // Apply the rowid LIMIT before scope probes. Each statement sees the same candidate:
    // these writes cannot change scope eligibility, and only the final write deletes a parent.
    const selection = `WITH scan AS MATERIALIZED (
      SELECT rowid AS rid,id FROM follow_subscribers WHERE ${p.selected}
    ), candidate AS MATERIALIZED (
      SELECT min(rid) AS rid FROM scan p WHERE ${absent("p.id")}
    ) `;
    const selected = lookahead ? `rowid=(${selection} SELECT rid FROM candidate)` : p.selected;
    const parent = lookahead
      ? `${selection} SELECT id FROM scan WHERE rid=(SELECT rid FROM candidate)`
      : `SELECT id FROM follow_subscribers WHERE ${p.selected}`;
    // Each indexed child prefix is bounded before filtering current scope absence.
    // NOT INDEXED applies only to the outer rowid mutation, never to child selection.
    const tokens = `SELECT t.rowid FROM follow_tokens t INDEXED BY follow_tokens_subscriber
      WHERE t.subscriber_id=(${parent}) ORDER BY t.purpose,t.scope_key,t.rowid LIMIT ?`;
    const digests = `SELECT d.rowid FROM follow_digest_outbox d INDEXED BY sqlite_autoindex_follow_digest_outbox_2
      WHERE d.subscriber_id=(${parent}) ORDER BY d.day,d.rowid LIMIT ?`;
    const raw = dense(
      await db.batch([
        ...p.initial,
        db
          .prepare(
            lookahead
              ? `SELECT * FROM (${selection} SELECT CASE WHEN rid IS NULL THEN 0 ELSE 1 END AS eligible,
              CAST(rid AS TEXT) AS candidate,
              CAST((SELECT max(rid) FROM scan WHERE rid<candidate.rid) AS TEXT) AS previous FROM candidate)`
              : `SELECT count(*) AS eligible FROM follow_subscribers WHERE ${p.selected} AND ${absent("follow_subscribers.id")}`,
          )
          .bind(...p.args),
        db
          .prepare(
            `DELETE FROM follow_tokens NOT INDEXED WHERE rowid IN (${tokens}) AND ${absent("follow_tokens.subscriber_id")}`,
          )
          .bind(...p.args, maxChildren),
        db.prepare("SELECT changes() AS changed"),
        db
          .prepare(
            `DELETE FROM follow_digest_outbox NOT INDEXED WHERE rowid IN (${digests}) AND ${absent("follow_digest_outbox.subscriber_id")}`,
          )
          .bind(...p.args, maxChildren),
        db.prepare("SELECT changes() AS changed"),
        db
          .prepare(
            `DELETE FROM follow_subscribers NOT INDEXED WHERE ${selected} AND ${absent("follow_subscribers.id")}
        AND NOT EXISTS(SELECT 1 FROM follow_tokens t WHERE t.subscriber_id=follow_subscribers.id)
        AND NOT EXISTS(SELECT 1 FROM follow_digest_outbox d WHERE d.subscriber_id=follow_subscribers.id)
        ${lookahead ? "RETURNING CAST(rowid AS TEXT) AS removed_rowid" : ""}`,
          )
          .bind(...p.args),
        db.prepare("SELECT changes() AS changed"),
      ]),
      9,
    );
    if (raw.length !== 9) fail();
    const r = raw.map(receipt),
      snapshot = p.validate(r);
    if (r[2].changes !== 0 || r[2].rows.length !== 1) fail();
    const eligibleRow = record(r[2].rows[0]),
      eligible = eligibleRow.eligible;
    if (
      Object.keys(eligibleRow).sort().join() !==
        (lookahead ? "candidate,eligible,previous" : "eligible") ||
      ![0, 1].includes(eligible) ||
      eligible > snapshot.examined
    )
      fail();
    const tokensRemoved = changed(r[3], r[4], maxChildren, 4);
    const digestsRemoved = changed(r[5], r[6], maxChildren, 2);
    // Arbitrary children are gone; only the unique management job and owner reference can cascade.
    const removed = changed(lookahead ? { ...r[7], rows: [] } : r[7], r[8], eligible, 3);
    if (lookahead) {
      // Only the decisive mutation can certify advancement. A selector receipt alone
      // cannot establish which root was removed, and drainage retains the incoming cursor.
      if (r[7].rows.length !== removed) fail();
      if (removed) {
        const deleted = record(r[7].rows[0]);
        if (
          Object.keys(deleted).join() !== "removed_rowid" ||
          deleted.removed_rowid !== eligibleRow.candidate
        )
          fail();
        rowid(deleted.removed_rowid);
      }
    }
    if (!eligible && (tokensRemoved || digestsRemoved)) fail();
    const draining = eligible === 1 && removed === 0;
    if (lookahead && !eligible && (eligibleRow.candidate !== null || eligibleRow.previous !== null))
      fail();
    const continuation =
      lookahead && eligible
        ? snapshot.finishCandidate(eligibleRow.candidate, eligibleRow.previous, draining)
        : snapshot.finish(draining);
    return {
      status: "maintained",
      examined: snapshot.examined,
      tokensRemoved,
      digestsRemoved,
      removed,
      draining,
      ...continuation,
    };
  } catch {
    // A write can have committed. No automatic retry or continuation after uncertainty.
    return unavailable();
  }
}
