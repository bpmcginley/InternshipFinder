// Dormant response boundary: no endpoint, credential, transport retry or production limits.
import { HttpError } from "./http.js";
import { acceptFundedCall, releaseFundedCall, meterFundedCall } from "./funded-run-callbacks.js";

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const upstreamError = () => new HttpError(502, "upstream", "AI response could not be completed");
const pendingError = () => new HttpError(503, "busy", "AI response is temporarily unavailable");
function facts(data) {
  const candidate = Array.isArray(data?.candidates) ? data.candidates[0] : null;
  const usable =
    Array.isArray(candidate?.content?.parts) &&
    candidate.content.parts.some(
      (p) =>
        object(p) &&
        !p.thought &&
        ((typeof p.text === "string" && p.text.trim().length > 0) ||
          (object(p.functionCall) &&
            typeof p.functionCall.name === "string" &&
            p.functionCall.name.trim().length > 0 &&
            (p.functionCall.args === undefined || object(p.functionCall.args)))),
    );
  const terminal =
    (typeof candidate?.finishReason === "string" && candidate.finishReason.length > 0) ||
    (typeof data?.promptFeedback?.blockReason === "string" &&
      data.promptFeedback.blockReason.length > 0);
  const usage = data?.usageMetadata;
  const keys = [
    "promptTokenCount",
    "cachedContentTokenCount",
    "candidatesTokenCount",
    "thoughtsTokenCount",
    "toolUsePromptTokenCount",
  ];
  const validUsage =
    object(usage) &&
    keys.some((k) => Object.hasOwn(usage, k)) &&
    keys.every((k) => usage[k] === undefined || (Number.isSafeInteger(usage[k]) && usage[k] >= 0));
  return { usable: !!usable, terminal, usage: validUsage ? usage : null };
}

// send must be a bounded, one-attempt trusted adapter returning the raw Response;
// it must not hide a rejected HTTP response as a thrown uncertain transport failure.
// limits and response headers are trusted server inputs, never client-selected.
export async function fundedProviderResponse({
  db,
  identity,
  send,
  stream = false,
  headers,
  price,
  model,
  limits,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  clock = () => performance.now(),
}) {
  if (
    !limits ||
    ![limits.maxBytes, limits.maxEventBytes, limits.deadlineMs].every(
      (n) => Number.isSafeInteger(n) && n > 0,
    ) ||
    typeof send !== "function" ||
    typeof price !== "function" ||
    typeof stream !== "boolean" ||
    typeof clock !== "function"
  )
    throw pendingError();
  const started = clock();
  let last = started,
    expired = false,
    stopped = false;
  // Timer tasks can be starved by ready stream reads. The monotonic clock is the
  // deadline authority; the timer only wakes/cancels an otherwise stalled reader.
  const checkDeadline = () => {
    const current = clock();
    if (
      !Number.isFinite(current) ||
      !Number.isFinite(started) ||
      current < last ||
      current - started >= limits.deadlineMs
    )
      expired = true;
    last = current;
    if (expired || stopped) throw upstreamError();
  };
  let upstream;
  try {
    checkDeadline();
    upstream = await send();
    checkDeadline();
  } catch {
    void upstream?.body?.cancel().catch(() => {});
    throw upstreamError();
  } // Unknown transport: retain reservation.
  if (!(upstream instanceof Response)) throw upstreamError();
  if (!upstream.ok) {
    void upstream.body?.cancel().catch(() => {});
    checkDeadline();
    await releaseFundedCall(db, identity); // Explicit HTTP rejection, not an uncertain send.
    throw upstreamError();
  }
  if (!upstream.body) throw upstreamError();
  const reader = upstream.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  const chunks = [];
  let total = 0,
    closed = false,
    metering = false,
    accepted = false,
    terminal = false,
    usage = null,
    text = "",
    event = "";
  let settleCompletion;
  const completion = new Promise((resolve) => {
    settleCompletion = resolve;
  });
  const finish = () => {
    if (!closed) {
      closed = true;
      clearTimer(timer);
    }
    if (!metering) settleCompletion();
  };
  const stop = () => {
    stopped = true;
    void reader.cancel().catch(() => {});
    finish();
  };
  const timer = setTimer(
    () => {
      expired = true;
      stop();
    },
    Math.max(0, limits.deadlineMs - (last - started)),
  );
  const meter = async () => {
    checkDeadline();
    if (usage) {
      let cents;
      try {
        cents = price(usage);
      } catch {
        return;
      }
      checkDeadline();
      if (typeof cents === "number" && Number.isFinite(cents) && cents >= 0) {
        metering = true;
        try {
          await meterFundedCall(db, identity, { cents, usage, model });
        } finally {
          metering = false;
          if (closed) settleCompletion();
        }
      }
    }
  };
  const accept = async () => {
    checkDeadline();
    const result = await acceptFundedCall(db, identity);
    if (result.status !== "accepted") throw pendingError();
    accepted = true;
    checkDeadline();
  };
  const inspect = (data) => {
    const f = facts(data);
    if (f.terminal) terminal = true;
    else if (data?.candidates?.length) {
      terminal = false;
      usage = null;
    }
    // A usage-only trailer after terminal output is also authoritative at clean EOF.
    // New nonterminal content invalidates the earlier completion and running totals.
    else if (data?.usageMetadata) usage = terminal ? f.usage : null;
    if (f.terminal) usage = f.usage;
    return f.usable;
  };
  const scan = (piece, final = false) => {
    text += piece;
    let usable = false,
      end;
    while ((end = text.indexOf("\n")) >= 0) {
      const line = text.slice(0, end).replace(/\r$/, "");
      text = text.slice(end + 1);
      if (line === "") {
        if (event) {
          const value = event.endsWith("\n") ? event.slice(0, -1) : event;
          if (value !== "[DONE]") usable = inspect(JSON.parse(value)) || usable;
          event = "";
        }
      } else if (line.startsWith("data:")) event += line.slice(5).replace(/^ /, "") + "\n";
      if (new TextEncoder().encode(event).byteLength > limits.maxEventBytes) throw upstreamError();
    }
    if (new TextEncoder().encode(text + event).byteLength > limits.maxEventBytes)
      throw upstreamError();
    if (final && (text.trim() || event)) throw upstreamError(); // Incomplete event is not proof of completion.
    return usable;
  };
  const read = async () => {
    checkDeadline();
    const result = await reader.read();
    checkDeadline();
    if (!result.done) {
      if (!(result.value instanceof Uint8Array)) throw upstreamError();
      total += result.value.byteLength;
      if (total > limits.maxBytes) throw upstreamError();
    }
    return result;
  };
  try {
    if (!stream) {
      for (;;) {
        const r = await read();
        if (r.done) break;
        chunks.push(r.value);
        text += decoder.decode(r.value, { stream: true });
      }
      text += decoder.decode();
      const data = JSON.parse(text),
        f = facts(data);
      checkDeadline();
      if (!f.usable) {
        if (f.terminal) await releaseFundedCall(db, identity);
        throw upstreamError();
      }
      await accept();
      usage = f.usage;
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.length;
      }
      checkDeadline();
      clearTimer(timer);
      void meter()
        .catch(() => {})
        .finally(finish);
      const response = new Response(bytes, { status: 200, headers });
      checkDeadline();
      return { response, completion };
    }
    // Hold every original byte until a complete usable event and durable acceptance.
    while (!accepted) {
      const r = await read();
      if (r.done) {
        scan(decoder.decode(), true);
        checkDeadline();
        if (terminal) await releaseFundedCall(db, identity);
        throw upstreamError();
      }
      chunks.push(r.value);
      if (scan(decoder.decode(r.value, { stream: true }))) await accept();
    }
    const body = new ReadableStream({
      async pull(controller) {
        try {
          checkDeadline();
          if (chunks.length) {
            controller.enqueue(chunks.shift());
            return;
          }
          const r = await read();
          if (r.done) {
            scan(decoder.decode(), true);
            if (terminal) await meter();
            checkDeadline();
            controller.close();
            finish();
            return;
          }
          scan(decoder.decode(r.value, { stream: true }));
          checkDeadline();
          controller.enqueue(r.value);
        } catch {
          controller.error(upstreamError());
          stop();
        }
      },
      cancel() {
        stop();
      },
    });
    const response = new Response(body, { status: 200, headers });
    checkDeadline();
    return { response, completion };
  } catch (e) {
    stop();
    throw e instanceof HttpError ? e : upstreamError();
  }
}
