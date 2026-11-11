import test from "node:test";
import assert from "node:assert/strict";
import {
  readTopupReversalEvidence,
  REVERSAL_BOUNDS as cap,
} from "../src/topup-reversal-evidence.js";
const evidence = {
  status: "paid_evidence",
  paymentId: "pi_fixture",
  chargeId: "ch_fixture",
  checkoutId: "cs_fixture",
  capturedAmount: 327,
  currency: "usd",
  livemode: false,
};
const env = { STRIPE_SECRET_KEY: "fixture-not-a-key" };
const item = (kind, n, status = kind === "refunds" ? "failed" : "won") => ({
  object: kind === "refunds" ? "refund" : "dispute",
  id: (kind === "refunds" ? "re_" : "du_") + n,
  charge: "ch_fixture",
  payment_intent: null,
  currency: "usd",
  amount: 1,
  status,
  ...(kind === "disputes" ? { livemode: false } : {}),
  metadata: { private: "fixture-must-not-return" },
});
const charge = () => ({
  object: "charge",
  id: "ch_fixture",
  payment_intent: "pi_fixture",
  currency: "usd",
  livemode: false,
  status: "succeeded",
  paid: true,
  captured: true,
  amount: 327,
  amount_captured: 327,
  amount_refunded: 0,
  refunded: false,
  disputed: false,
});
const response = (value) => new Response(JSON.stringify(value));
function provider(refunds = [], disputes = [], alter = () => {}) {
  const calls = [],
    counts = { refunds: 0, disputes: 0, charges: 0 };
  const fetch = async (url, options) => {
    const parsed = new URL(url),
      kind = parsed.pathname.split("/")[2];
    calls.push(url);
    counts[kind]++;
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers["Stripe-Version"], "2026-08-26.dahlia");
    assert.equal(options.signal.aborted, false);
    let value;
    if (kind === "charges") {
      assert.equal(parsed.pathname, "/v1/charges/ch_fixture");
      value = charge();
      value.amount_refunded = Math.min(
        327,
        refunds.filter((r) => r.status === "succeeded").reduce((sum, r) => sum + r.amount, 0),
      );
      value.refunded = value.amount_refunded === 327;
      value.disputed = disputes.length > 0;
    } else {
      assert.ok(["refunds", "disputes"].includes(kind));
      assert.equal(parsed.searchParams.get("charge"), "ch_fixture");
      assert.equal(parsed.searchParams.get("limit"), "100");
      const all = kind === "refunds" ? refunds : disputes,
        cursor = parsed.searchParams.get("starting_after");
      const start = cursor ? all.findIndex((r) => r.id === cursor) + 1 : 0;
      assert.ok(!cursor || start > 0);
      value = {
        object: "list",
        url: "/v1/" + kind,
        data: structuredClone(all.slice(start, start + 100)),
        has_more: start + 100 < all.length,
      };
    }
    alter(value, kind, counts[kind]);
    return response(value);
  };
  return { fetch, calls, counts };
}
const run = (p) => readTopupReversalEvidence(env, evidence, p.fetch);
test("complete stable multi-page traversals return only normalized evidence", async () => {
  const p = provider(
    Array.from({ length: 120 }, (_, n) => item("refunds", n)),
    [item("disputes", 1, "under_review")],
  );
  const result = await run(p);
  assert.equal(result.status, "reversal_evidence");
  assert.equal(result.refunds.length, 120);
  assert.equal(result.disputes.length, 1);
  assert.equal(result.refundsComplete, true);
  assert.equal(result.disputesComplete, true);
  assert.equal(p.calls.length, 8);
  assert.equal(result.capturedAmount, 327);
  assert.deepEqual(Object.keys(result.refunds[0]).sort(), ["amount", "currency", "id", "status"]);
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(Object.hasOwn(result, "disposition"), false);
  assert.equal((await run(provider())).status, "reversal_evidence");
});
test("hard page/object/request bounds permit the boundary and never return truncation", async () => {
  const many = (kind) => Array.from({ length: 400 }, (_, n) => item(kind, n));
  const p = provider(many("refunds"), many("disputes"));
  assert.equal((await run(p)).status, "reversal_evidence");
  assert.equal(p.calls.length, cap.requests);
  const over = provider([...many("refunds"), item("refunds", 400)]);
  assert.deepEqual(await run(over), { status: "pending" });
  assert.equal(over.calls.length, 5);
});
test("malformed paging, repeated IDs/cursors and unrelated objects fail closed", async () => {
  for (const change of [
    (v) => (v.url = "https://other.invalid/next"),
    (v) => (v.object = "wrong"),
    (v) => (v.has_more = "false"),
    (v) => (v.data = null),
    (v) => {
      v.has_more = true;
      v.data = [];
    },
    (v) => v.data.push(v.data[0]),
    (v) => (v.data = Array.from({ length: 101 }, (_, n) => item("refunds", n))),
    (v) => (v.data[0].charge = "ch_other"),
    (v) => (v.data[0].payment_intent = "pi_other"),
    (v) => (v.data[0].id = "../bad"),
    (v) => (v.data[0].currency = "cad"),
    (v) => (v.data[0].amount = 328),
    (v) => (v.data[0].amount = 1.5),
    (v) => (v.data[0].status = "future_status"),
    (v) => (v.data[0].object = "other"),
  ]) {
    const p = provider([item("refunds", 1)], [], (v, kind) => {
      if (kind === "refunds") change(v);
    });
    assert.deepEqual(await run(p), { status: "pending" });
  }
  const loop = provider([item("refunds", 1)], [], (v, kind) => {
    if (kind === "refunds") {
      v.data = [item("refunds", 1)];
      v.has_more = true;
    }
  });
  assert.deepEqual(await run(loop), { status: "pending" });
  assert.equal(loop.calls.length, 3);
  for (const change of [(v) => (v.data[0].livemode = true), (v) => (v.data[0].amount = 328)])
    assert.deepEqual(
      await run(
        provider([], [item("disputes", 1)], (v, kind) => {
          if (kind === "disputes") change(v);
        }),
      ),
      { status: "pending" },
    );
});
test("every existing policy status is supported without changing refund/dispute rules", async () => {
  for (const status of ["succeeded", "pending", "requires_action", "failed", "canceled"])
    assert.equal((await run(provider([item("refunds", 1, status)]))).status, "reversal_evidence");
  for (const status of [
    "needs_response",
    "under_review",
    "appeal_needs_response",
    "appeal_under_review",
    "won",
    "warning_closed",
    "prevented",
    "warning_needs_response",
    "warning_under_review",
    "lost",
  ])
    assert.equal(
      (await run(provider([], [item("disputes", 1, status)]))).status,
      "reversal_evidence",
    );
  const full = item("refunds", 1, "succeeded");
  full.amount = 327;
  assert.equal((await run(provider([full]))).status, "reversal_evidence");
  assert.deepEqual(await run(provider([full, item("refunds", 2, "succeeded")])), {
    status: "pending",
  });
});
test("observed membership/status changes or changed Charge bookends remain pending", async () => {
  for (const change of [
    (v) => v.data.push(item("refunds", 2)),
    (v) => (v.data[0].status = "succeeded"),
    (v) => (v.data[0].amount = 2),
  ])
    assert.deepEqual(
      await run(
        provider([item("refunds", 1)], [], (v, kind, n) => {
          if (kind === "refunds" && n === 2) change(v);
        }),
      ),
      { status: "pending" },
    );
  assert.deepEqual(
    await run(
      provider([], [], (v, kind, n) => {
        if (kind === "charges" && n === 2) v.disputed = true;
      }),
    ),
    { status: "pending" },
  );
  for (const change of [
    (v) => (v.id = "ch_other"),
    (v) => (v.payment_intent = "pi_other"),
    (v) => (v.livemode = true),
    (v) => (v.currency = "cad"),
    (v) => (v.amount_captured = 300),
    (v) => (v.amount_refunded = 328),
    (v) => (v.refunded = null),
  ])
    assert.deepEqual(
      await run(
        provider([], [], (v, kind) => {
          if (kind === "charges") change(v);
        }),
      ),
      { status: "pending" },
    );
});
test("Charge aggregates must be compatible with complete observed lists", async () => {
  const successful = item("refunds", 1, "succeeded");
  assert.deepEqual(
    await run(
      provider([successful], [], (v, kind) => {
        if (kind === "charges") v.amount_refunded = 0;
      }),
    ),
    { status: "pending" },
  );
  assert.deepEqual(
    await run(
      provider([], [], (v, kind) => {
        if (kind === "charges") v.amount_refunded = 1;
      }),
    ),
    { status: "pending" },
  );
  assert.deepEqual(
    await run(
      provider([], [], (v, kind) => {
        if (kind === "charges") v.disputed = true;
      }),
    ),
    { status: "pending" },
  );
  for (const status of ["pending", "requires_action"]) {
    const inFlight = { ...item("refunds", 1, status), amount: 327 };
    assert.equal(
      (
        await run(
          provider([inFlight], [], (value, kind) => {
            if (kind === "charges") {
              value.amount_refunded = 327;
              value.refunded = true;
            }
          }),
        )
      ).status,
      "reversal_evidence",
    );
  }
  // Pending may or may not contribute to the aggregate; neither variant is counted as successful.
  for (const aggregate of [0, 1])
    assert.equal(
      (
        await run(
          provider([item("refunds", 1, "pending")], [], (v, kind) => {
            if (kind === "charges") v.amount_refunded = aggregate;
          }),
        )
      ).status,
      "reversal_evidence",
    );
});
for (const status of ["failed", "canceled"]) {
  test(`a ${status} refund cannot explain a fully refunded Charge`, async () => {
    const refund = { ...item("refunds", 1, status), amount: 327 };
    const p = provider([refund], [], (value, kind) => {
      if (kind === "charges") {
        value.amount_refunded = 327;
        value.refunded = true;
      }
    });
    assert.deepEqual(await run(p), { status: "pending" });
  });
}
test("streamed byte limits and UTF-8 are enforced before JSON normalization", async () => {
  const padded = (length, every = false) => {
    const p = provider(),
      original = p.fetch;
    let n = 0;
    p.fetch = async (...args) => {
      const text = await (await original(...args)).text();
      return new Response(every || ++n === 1 ? text.padEnd(length, " ") : text);
    };
    return p;
  };
  const unicode = provider(),
    original = unicode.fetch;
  unicode.fetch = async (...args) => {
    const value = await (await original(...args)).json();
    value.extra = "🙂";
    const text = JSON.stringify(value),
      bytes = new TextEncoder().encode(text);
    const cut = new TextEncoder().encode(text.slice(0, text.indexOf("🙂"))).length + 1;
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, cut));
          controller.enqueue(bytes.slice(cut));
          controller.close();
        },
      }),
    );
  };
  assert.equal((await run(unicode)).status, "reversal_evidence");
  const text = JSON.stringify(charge());
  assert.deepEqual(
    await readTopupReversalEvidence(
      env,
      evidence,
      async () => new Response(text + " ".repeat(cap.bodyBytes - text.length - 1) + "é"),
    ),
    { status: "pending" },
  );
  assert.equal((await run(padded(cap.bodyBytes))).status, "reversal_evidence");
  assert.deepEqual(await run(padded(cap.bodyBytes + 1)), { status: "pending" });
  assert.deepEqual(await run(padded(200000, true)), { status: "pending" });
  assert.deepEqual(
    await readTopupReversalEvidence(env, evidence, async () => new Response(new Uint8Array([255]))),
    { status: "pending" },
  );
});
test("deadline aborts stalled fetch/body and discards late results without new calls", async () => {
  let resume,
    calls = 0,
    signal;
  const result = await readTopupReversalEvidence(
    env,
    evidence,
    async (_url, options) => {
      calls++;
      signal = options.signal;
      return await new Promise((resolve) => {
        resume = resolve;
      });
    },
    10,
  );
  assert.deepEqual(result, { status: "pending" });
  assert.equal(signal.aborted, true);
  resume(response(charge()));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 1);
  let canceled = false;
  const stream = new ReadableStream({
    cancel() {
      canceled = true;
    },
  });
  assert.deepEqual(
    await readTopupReversalEvidence(env, evidence, async () => new Response(stream), 10),
    { status: "pending" },
  );
  assert.equal(canceled, true);
});
test("disabled inputs and provider failures return no partial or private output", async () => {
  const noFetch = () => assert.fail("no fetch");
  for (const invalid of [
    { ...evidence, status: "expired_evidence" },
    { ...evidence, paymentId: "../bad" },
    { ...evidence, capturedAmount: 0 },
  ])
    assert.deepEqual(await readTopupReversalEvidence(env, invalid, noFetch), { status: "pending" });
  assert.deepEqual(await readTopupReversalEvidence({}, evidence, noFetch), { status: "pending" });
  assert.deepEqual(await readTopupReversalEvidence(env, evidence), { status: "pending" });
  assert.deepEqual(await readTopupReversalEvidence(env, evidence, noFetch, cap.timeoutMs + 1), {
    status: "pending",
  });
  const original = console.error,
    logs = [];
  console.error = (...args) => logs.push(args);
  try {
    for (const fetch of [
      () => {
        throw new Error("fixture-private-network");
      },
      async () => new Response("fixture-private-error", { status: 500 }),
      async () => new Response("fixture-private-bad-json"),
    ])
      assert.deepEqual(await readTopupReversalEvidence(env, evidence, fetch), {
        status: "pending",
      });
    const p = provider(),
      f = p.fetch;
    p.fetch = async (...args) =>
      p.calls.length === 3 ? new Response("failure", { status: 500 }) : f(...args);
    assert.deepEqual(await run(p), { status: "pending" });
    assert.deepEqual(logs, []);
  } finally {
    console.error = original;
  }
});
