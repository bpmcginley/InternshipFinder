import assert from "node:assert/strict";
import { createFollowEmailTransport as create } from "../src/follow-email-transport.js";
import { renderFollowMail } from "../src/follow-mail.js";
import { deliverFollowManagement as deliver } from "../src/follow-management-delivery.js";
import { seed, config } from "./follow-management-delivery.js";
const denied = { name: "Error", message: "Follow mail attempt uncertain" };
const token = "10000000-0000-4000-8000-000000000001." + "a".repeat(64);
const rendered = (kind = "confirm") =>
  renderFollowMail(kind, {
    from: "Synthetic Sender <sender@example.test>",
    to: "reader@example.test",
    postalAddress: "TEST FIXTURE ONLY\nNo real postal address",
    summary: "Fixture Company",
    origins: ["https://fixture.example.test"],
    links: {
      confirmation: "https://fixture.example.test/confirm/fixture",
      deleteRequest: "https://fixture.example.test/delete/fixture",
      management: "https://fixture.example.test/manage/fixture",
      unsubscribe: "https://fixture.example.test/unsubscribe/" + token,
      matchingPage: "https://fixture.example.test/matches",
      publicShare: "https://fixture.example.test/share",
    },
    matches: [
      {
        id: "0000000000000001",
        company_name: "Fixture",
        title: "Intern",
        location: "Remote",
        apply_url: "https://jobs.example.test/1",
      },
    ],
  });
export async function defaultClosedDoesNotInspectOrCallBinding() {
  let reads = 0;
  const email = {
    get send() {
      reads++;
      throw Error("private fixture");
    },
  };
  for (const enabled of [undefined, false, "true", 1])
    await assert.rejects(create({ enabled, email })(rendered()), denied);
  assert.equal(reads, 0);
  for (const change of [{ email: {} }, { timeoutMs: 0 }, { timeoutMs: 10001 }, { clock: null }])
    await assert.rejects(create({ enabled: true, email, ...change })(rendered()), denied);
  assert.equal(reads, 0);
}
export async function threeApprovedEnvelopesReachOneImmediateCallUnchanged() {
  for (const kind of ["confirm", "manage", "digest"]) {
    const message = rendered(kind),
      expected = structuredClone(message),
      sent = [];
    const email = {
      send(value) {
        assert.equal(this, email);
        sent.push(value);
        return Promise.resolve({ messageId: "synthetic-id" });
      },
    };
    const transport = create({ enabled: true, email });
    const pending = transport(message);
    assert.equal(sent.length, 1); // The caller's fresh fence has no intervening await.
    message.from.email = "changed@example.test";
    message.headers["List-Unsubscribe"] = "changed";
    message.text = "changed";
    assert.deepEqual(sent, [expected]);
    assert.deepEqual(await pending, { status: "accepted" });
  }
}
export async function malformedEnvelopeNeverInvokesBinding() {
  let calls = 0;
  const transport = create({
    enabled: true,
    email: {
      send() {
        calls++;
        return Promise.resolve({ messageId: "synthetic" });
      },
    },
  });
  for (const change of [
    { bcc: "other@example.test" },
    { to: ["reader@example.test"] },
    { subject: "bad\r\nsubject" },
    { text: "é".repeat(131073) },
    { from: { email: "sender@example.test", name: "Fixture", extra: true } },
    {
      headers: {
        "List-Unsubscribe": "<https://fixture.example.test/u>",
        "List-Unsubscribe-Post": "wrong",
      },
    },
  ])
    await assert.rejects(transport({ ...rendered(), ...change }), denied);
  const accessor = rendered();
  Object.defineProperty(accessor, "text", {
    enumerable: true,
    get() {
      throw Error("private getter");
    },
  });
  await assert.rejects(transport(accessor), denied);
  assert.equal(calls, 0);
}
export async function unknownReceiptsAndThrowsNeverFulfillOrRetry() {
  for (const receipt of [
    undefined,
    null,
    true,
    "accepted",
    {},
    { messageId: "" },
    { messageId: 1 },
    { messageId: "x\n" },
    { messageId: "x".repeat(257) },
    { messageId: "id", unknown: true },
  ]) {
    let calls = 0;
    const transport = create({
      enabled: true,
      email: {
        send() {
          calls++;
          return Promise.resolve(receipt);
        },
      },
    });
    await assert.rejects(transport(rendered()), denied);
    assert.equal(calls, 1);
  }
  for (const mode of ["throw", "reject", "sync"]) {
    let calls = 0;
    const transport = create({
      enabled: true,
      email: {
        send() {
          calls++;
          if (mode === "throw") throw Error("private provider body");
          return mode === "reject"
            ? Promise.reject(Error("private provider body"))
            : { messageId: "id" };
        },
      },
    });
    await assert.rejects(transport(rendered()), denied);
    assert.equal(calls, 1);
  }
}
export async function unresolvedTimeoutStaysBusyAndLateReceiptNeverEscapes() {
  for (const lateReject of [false, true]) {
    let finish,
      calls = 0;
    const transport = create({
      enabled: true,
      timeoutMs: 10,
      email: {
        send() {
          calls++;
          return calls === 1
            ? new Promise((resolve, reject) => {
                finish = lateReject ? reject : resolve;
              })
            : Promise.resolve({ messageId: "next" });
        },
      },
    });
    const first = transport(rendered());
    await assert.rejects(transport(rendered()), denied);
    await assert.rejects(first, denied);
    await assert.rejects(transport(rendered()), denied);
    assert.equal(calls, 1);
    finish(lateReject ? Error("private late rejection") : { messageId: "late" });
    await Promise.resolve();
    await Promise.resolve();
    await assert.rejects(first, denied);
    assert.deepEqual(await transport(rendered()), { status: "accepted" });
    assert.equal(calls, 2);
  }
}
export async function absoluteDeadlineRollbackAndRejectedClocksFailClosed() {
  for (const mode of ["deadline", "rollback", "early-reject", "final-reject"]) {
    let after = false,
      calls = 0;
    const transport = create({
      enabled: true,
      timeoutMs: 100,
      clock: () => {
        if (mode === "early-reject" || (after && mode === "final-reject"))
          return Promise.reject(Error("private clock"));
        return after ? (mode === "rollback" ? 99 : 200) : 100;
      },
      email: {
        send() {
          calls++;
          after = true;
          return Promise.resolve({ messageId: "synthetic" });
        },
      },
    });
    await assert.rejects(transport(rendered()), denied);
    assert.equal(calls, mode === "early-reject" ? 0 : 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
export async function realManagementClaimIsSpentAfterAmbiguousProviderReceipt(db) {
  const jobId = await seed(db);
  let calls = 0;
  const transport = create({
    enabled: true,
    email: {
      send() {
        calls++;
        return Promise.resolve(undefined);
      },
    },
  });
  const args = { ...config(db), jobId, transport };
  assert.deepEqual(await deliver(args), { status: "uncertain" });
  assert.deepEqual(await deliver(args), { status: "unavailable" });
  assert.equal(calls, 1);
  assert.equal(await db.prepare("SELECT attempts FROM follow_send_budget").first("attempts"), 1);
  assert.ok(
    await db
      .prepare("SELECT claim_id FROM follow_management_outbox WHERE id=?")
      .bind(jobId)
      .first("claim_id"),
  );
}
export async function realManagementClaimAcceptsOnlyStructuredBindingReceipt(db) {
  const jobId = await seed(db);
  let calls = 0;
  const transport = create({
    enabled: true,
    email: {
      send() {
        calls++;
        return Promise.resolve({ messageId: "synthetic" });
      },
    },
  });
  assert.deepEqual(await deliver({ ...config(db), jobId, transport }), { status: "accepted" });
  assert.equal(calls, 1);
  assert.equal(await db.prepare("SELECT attempts FROM follow_send_budget").first("attempts"), 1);
}
