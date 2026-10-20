// Plain-text email over Cloudflare Email Sending (added 2026-10-19 for the paid listing orders,
// src/orders.js). The `send_email` binding named EMAIL is commented out in wrangler.toml until
// internscout.org is onboarded to Email Sending; until then env.EMAIL is missing and orders stay off.
//
// The binding takes a structured message: { from, to, subject, text, replyTo } (Cloudflare docs,
// "Email Sending Workers API", send()). `from` and `replyTo` may each be "a@b.c" or { email, name }.
// Plain text only: nothing an employer typed can turn into markup in someone's mail client.
//
// What is never logged: an address, a subject or a body. A failure logs only Cloudflare's error code.

export const mailOn = (env) => !!(env.EMAIL && typeof env.EMAIL.send === "function" && env.ORDER_FROM);

// "InternScout <listings@internscout.org>" becomes { email, name }; a bare address stays a string.
export function addressOf(s) {
  const m = /^\s*"?([^"<>]*?)"?\s*<([^<>\s]+)>\s*$/.exec(String(s || ""));
  if (!m) return String(s || "").trim();
  return m[1] ? { email: m[2], name: m[1] } : m[2];
}

// A subject is one line. Anything typed by an employer that reaches one (a company name) has had its
// line breaks folded already, and this makes sure of it.
const oneLine = (s) => String(s || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

export async function sendMail(env, { to, subject, text, replyTo }) {
  if (!mailOn(env)) throw new Error("Email sending is not set up");
  const msg = { from: addressOf(env.ORDER_FROM), to, subject: oneLine(subject), text: String(text || "") };
  if (replyTo) msg.replyTo = addressOf(replyTo);
  return env.EMAIL.send(msg);
}

// For an email sent after a database change has been made: a failure is logged and reported as false,
// never thrown, so it can never undo the change (a payment record above all). The caller records
// whether it went, and the daily cron sends again what has to be sent again.
export async function trySend(env, mail, what = "mail") {
  try {
    await sendMail(env, mail);
    return true;
  } catch (e) {
    console.error("mail failed:", what, e && (e.code || e.name));
    return false;
  }
}
