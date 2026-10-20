// Cloudflare Email Sending's structured binding contract, with no real emails or service calls.
import test from "node:test";
import assert from "node:assert/strict";
import { addressOf, mailOn, sendMail, trySend } from "../src/mail.js";

test("mail address parsing keeps a bare address or a structured display name", () => {
  assert.equal(addressOf(" listings@internscout.example "), "listings@internscout.example");
  assert.deepEqual(addressOf('"InternScout" <listings@internscout.example>'),
    { email: "listings@internscout.example", name: "InternScout" });
});

test("order email uses Cloudflare's structured send API and plain text", async () => {
  const sent = [];
  const env = { ORDER_FROM: "InternScout <listings@internscout.example>",
    EMAIL: { send: async (message) => { sent.push(message); return { messageId: "fake-message" }; } } };
  const result = await sendMail(env, { to: "hiring@employer.example", subject: "Order\r\n received\t today",
    text: "Company <script>text only</script>\nYour order is received.",
    replyTo: "InternScout support <support@internscout.example>" });
  assert.deepEqual(result, { messageId: "fake-message" });
  assert.deepEqual(sent, [{ from: { email: "listings@internscout.example", name: "InternScout" },
    to: "hiring@employer.example", subject: "Order received today",
    text: "Company <script>text only</script>\nYour order is received.",
    replyTo: { email: "support@internscout.example", name: "InternScout support" } }]);
  assert.ok(!("html" in sent[0]), "employer text is not rendered as email markup");
});

test("missing mail configuration refuses a send instead of reporting success", async () => {
  for (const env of [{}, { ORDER_FROM: "a@internscout.example" }, { EMAIL: { send() {} } }]) {
    assert.equal(mailOn(env), false);
    await assert.rejects(sendMail(env, {}), /not set up/);
  }
});

test("trySend reports provider failure without logging the recipient, content or error message", async () => {
  const logs = [], original = console.error;
  console.error = (...args) => logs.push(args);
  try {
    const env = { ORDER_FROM: "a@internscout.example", EMAIL: { send: async () => {
      throw Object.assign(new Error("private-recipient@employer.example private body"), { code: "E_DELIVERY_FAILED" });
    } } };
    assert.equal(await trySend(env, { to: "private-recipient@employer.example", subject: "private subject",
      text: "private body" }, "approved"), false);
    assert.deepEqual(logs, [["mail failed:", "approved", "E_DELIVERY_FAILED"]]);
  } finally {
    console.error = original;
  }
});
