// Dormant immediate transport for an already-rendered, freshly authorized Follow envelope.
// One shared instance serializes handoffs; no provider retry, logging or message-ID retention.
const failure = () => new Error("Follow mail attempt uncertain");
const fail = () => {
  throw failure();
};
function record(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getOwnPropertySymbols(value).length
  )
    fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).sort().join(",") !== keys) fail();
  const result = Object.create(null);
  for (const [key, d] of Object.entries(descriptors)) {
    if (!d.enumerable || !Object.hasOwn(d, "value")) fail();
    result[key] = d.value;
  }
  return result;
}
function line(value, max) {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail();
  return value;
}
function envelope(input) {
  const m = record(input, "from,headers,subject,text,to");
  const headers = record(m.headers, "List-Unsubscribe,List-Unsubscribe-Post");
  line(headers["List-Unsubscribe"], 2002);
  if (
    !/^<https:\/\/[^<>\s]+>$/.test(headers["List-Unsubscribe"]) ||
    headers["List-Unsubscribe-Post"] !== "List-Unsubscribe=One-Click"
  )
    fail();
  let from;
  if (typeof m.from === "string") from = line(m.from, 254);
  else {
    const address = record(m.from, "email,name");
    from = { email: line(address.email, 254), name: line(address.name, 200) };
  }
  if (
    typeof m.text !== "string" ||
    !m.text.length ||
    m.text.length > 262144 ||
    new TextEncoder().encode(m.text).byteLength > 262144
  )
    fail();
  return {
    from,
    to: line(m.to, 254),
    subject: line(m.subject, 200),
    text: m.text,
    headers: { ...headers },
  };
}
function sample(clock) {
  const value = clock();
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    void Promise.resolve(value).catch(() => {});
    fail();
  }
  return value;
}

export function createFollowEmailTransport({
  enabled = false,
  email,
  timeoutMs = 10000,
  clock = () => performance.now(),
} = {}) {
  let send = null,
    busy = false;
  if (
    enabled === true &&
    Number.isInteger(timeoutMs) &&
    timeoutMs > 0 &&
    timeoutMs <= 10000 &&
    typeof clock === "function"
  ) {
    try {
      const candidate = email?.send;
      if (typeof candidate === "function") send = candidate.bind(email);
    } catch {
      /* unavailable binding */
    }
  }
  return (input) => {
    let message, started;
    try {
      if (!send || busy) fail();
      message = envelope(input);
      started = sample(clock);
    } catch {
      return Promise.reject(failure());
    }
    busy = true;
    return new Promise((resolve, reject) => {
      let finished = false;
      const deny = () => {
        if (!finished) {
          finished = true;
          reject(failure());
        }
      };
      // EMAIL.send has no AbortSignal contract. Timeout cannot release an unresolved handoff.
      const timer = setTimeout(deny, timeoutMs);
      const settle = (result, rejected) => {
        busy = false;
        clearTimeout(timer);
        if (finished) return;
        try {
          if (rejected) fail();
          const now = sample(clock);
          if (now < started || now - started >= timeoutMs) fail();
          const receipt = record(result, "messageId");
          if (
            typeof receipt.messageId !== "string" ||
            !/^[\x21-\x7e]{1,256}$/.test(receipt.messageId)
          )
            fail();
          finished = true;
          resolve({ status: "accepted" });
        } catch {
          deny();
        }
      };
      try {
        // This call happens synchronously: no queue or awaited work after the caller's fence.
        const pending = send(message);
        if (!pending || typeof pending.then !== "function") fail();
        Promise.resolve(pending).then(
          (result) => settle(result, false),
          () => settle(null, true),
        );
      } catch {
        settle(null, true);
      }
    });
  };
}
