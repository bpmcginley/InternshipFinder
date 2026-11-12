import assert from "node:assert/strict";
import test from "node:test";
import { deliverFollowConfirmation } from "../src/follow-confirmation-delivery.js";

const at = "2099-01-01T23:59:59.900Z";
const job = {
  subscriber_id: "synthetic-subscriber",
  scope_key: "synthetic-scope",
  queued_at: "2099-01-01T00:00:00.000Z",
  expires_at: "2099-01-02T00:00:00.050Z",
  email: "synthetic@example.test",
};
const success = (changes, results = []) => ({ success: true, meta: { changes }, results });

for (const fault of ["none", "lost final reply", "UTC day rollover", "expiry", "backward clock"]) {
  test(`confirmation transport requires the exact final fence (${fault})`, async () => {
    let reads = 0;
    let checks = 0;
    let sent = 0;
    const db = {
      prepare: () => ({
        bind() {
          return this;
        },
        async all() {
          reads++;
          if (reads === 1) return success(0, [job]);
          if (reads === 2) return success(0, [{ at }]);
          if (fault === "lost final reply") throw new Error("Synthetic missing response");
          return success(0, [{ expires_at: job.expires_at }]);
        },
      }),
      batch: async () => [
        ...Array(6).fill(success(1)),
        success(0, [{ expires_at: job.expires_at }]),
        success(0),
      ],
    };
    const outcome = await deliverFollowConfirmation({
      db,
      jobId: crypto.randomUUID(),
      cap: 1,
      clock() {
        checks++;
        if (checks < 4) return new Date(at);
        if (fault === "UTC day rollover") return new Date("2099-01-02T00:00:00.000Z");
        if (fault === "expiry") return new Date(job.expires_at);
        if (fault === "backward clock") return new Date(Date.parse(at) - 1);
        return new Date(at);
      },
      present: ({ confirmation, deleteRequest, unsubscribe }) => ({
        from: "sender@example.test",
        summary: "Synthetic",
        postalAddress: "Synthetic",
        origins: ["https://mail.example.test"],
        links: {
          confirmation: `https://mail.example.test/confirm?token=${confirmation}`,
          deleteRequest: `https://mail.example.test/delete?token=${deleteRequest}`,
          unsubscribe: `https://mail.example.test/unsubscribe?token=${unsubscribe}`,
        },
      }),
      transport: async () => {
        sent++;
      },
    });
    assert.equal(reads, 3);
    assert.equal(sent, fault === "none" ? 1 : 0);
    assert.deepEqual(outcome, { status: fault === "none" ? "accepted" : "unavailable" });
  });
}
