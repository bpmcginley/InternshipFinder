import { hmacHex, siteUrl } from "../billing.js";
import { addDays } from "../placements.js";
import { WORKER_URL } from "../public-config.js";
import { CREDIT_DEFAULT_DAYS, DAYS, UNVERIFIED_DAYS, money, rolesWord } from "./shared.js";

// Each published version of the terms is kept unchanged under a git tag terms-YYYY-MM-DD (ORDERS.md).
export const TERMS_ARCHIVE = "https://github.com/bpmcginley/InternshipFinder/blob/terms-";

// Where Bruce's review links point. The Worker's own address; API_URL overrides it (wrangler dev).
const DEFAULT_API = WORKER_URL;

const apiUrl = (env) => (env.API_URL || DEFAULT_API).replace(/\/+$/, "");
const longDay = (day) => new Date(day + "T00:00:00Z").toLocaleDateString("en-US",
  { timeZone: "UTC", year: "numeric", month: "long", day: "numeric" });

// The review link's signature: hex HMAC-SHA256 under ADMIN_TOKEN of "review:" + order id.
export const reviewSig = (env, id) => hmacHex(env.ADMIN_TOKEN, "review:" + id);

// ---------------------------------------------------------------- the emails (plain text)

const sign = (env) => `\nInternScout\n${siteUrl(env)}\n`;
const roleList = (roles) => roles.map((r) => `- ${r.title || r.t}${(r.location || r.loc) ? ", " + (r.location || r.loc) : ""}`).join("\n");

function verifyMail(env, order, roles, token) {
  const link = `${siteUrl(env)}/employers/buy/?order=${order.id}&t=${token}`;
  return {
    to: order.email, replyTo: env.REVIEW_TO,
    subject: "Confirm your InternScout listing order",
    text: `Hello ${order.name},\n\nYou asked to list ${rolesWord(roles.length)} from ${order.employer} on InternScout for ` +
      `${DAYS} days from ${longDay(order.start_day)}:\n\n${roleList(roles)}\n\n` +
      (order.pilot_code
        ? "You entered a pilot code, so there is nothing to pay. Open this link within 48 hours to confirm the order:\n"
        : `To confirm this address and go on to payment (${money(order.price)}), open this link within 48 hours:\n`) +
      `${link}\n\nIf you did not ask for this, ignore this email. Nothing is charged, and the order is deleted after ` +
      `${UNVERIFIED_DAYS} days.\n${sign(env)}`,
  };
}

function receivedMail(env, order, roles) {
  return {
    to: order.email, replyTo: env.REVIEW_TO,
    subject: `We have your InternScout listing order ${order.id}`,
    text: `Hello ${order.name},\n\nWe have your order ${order.id}: ${rolesWord(roles.length)} from ${order.employer}, ` +
      `${DAYS} days each from ${longDay(order.start_day)}.\n\n${roleList(roles)}\n\n` +
      (order.pilot_code ? "This is a pilot order, so there is nothing to pay.\n\n"
        : `You paid ${money(order.paid_amount)}. Stripe emails your receipt and invoice separately.\n\n`) +
      "We review every order within 2 business days and email you when it is approved. If we can't list a role, " +
      "we refund the full amount and tell you why. Until we approve it, you can cancel it for a full refund by " +
      "replying to this email.\n\n" +
      `You accepted the InternScout terms, including the section for employers, as they read on ${longDay(order.terms_version)} ` +
      `(version ${order.terms_version}):\n${siteUrl(env)}/terms.html#employers\n` +
      `A copy of that version, kept unchanged: ${TERMS_ARCHIVE}${order.terms_version}/docs/terms.html#employers\n\n` +
      "If you have a question, reply to this email.\n" + sign(env),
  };
}

async function reviewMail(env, order, roles, reminder) {
  const link = `${apiUrl(env)}/employer/review?order=${order.id}&sig=${await reviewSig(env, order.id)}`;
  return {
    to: env.REVIEW_TO,
    subject: `${reminder ? "Reminder: still waiting, " : "Review "}listing order ${order.id}: ${order.employer}`,
    text: (reminder ? `Order ${order.id} has waited more than a day for your decision.\n\n` : `Order ${order.id} waits for your decision.\n\n`) +
      `Employer (role index): ${order.employer}\nCompany typed: ${order.company}\nContact: ${order.name}, ${order.email} ` +
      `(domain ${order.email_domain})\nNonprofit or public body: ${order.public_body ? "yes, claimed" : "no"}\n` +
      `Package: ${order.package}, ${rolesWord(roles.length)}\nPaid: ${money(order.paid_amount)} (${order.paid_ref})\n` +
      `Start: ${order.start_day}\n\nRoles:\n${roles.map((r) => `- ${r.title}: ${r.apply_url}`).join("\n")}\n\n` +
      `Approve or refuse here:\n${link}\n`,
  };
}

function approvedMail(env, order, done) {
  return {
    to: order.email, replyTo: env.REVIEW_TO,
    subject: `Your InternScout listing order ${order.id} is approved`,
    text: `Hello ${order.name},\n\nYour order ${order.id} is approved. These roles show in a separate, labelled box on ` +
      "InternScout on these days (UTC):\n\n" +
      done.map(({ role, p }) => `- ${role.title}: ${longDay(p.start_day)} through ${longDay(addDays(p.end_day, -1))}`).join("\n") +
      "\n\nThey appear once the site next updates. Paying does not change where any listing ranks or how it is scored. " +
      "If a role closes early, we email you about its unused days.\n" + sign(env),
  };
}

function refusedMail(env, order, reason, refunded) {
  return {
    to: order.email, replyTo: env.REVIEW_TO,
    subject: `Your InternScout listing order ${order.id}`,
    text: `Hello ${order.name},\n\nWe are not able to list order ${order.id}. The reason: ${reason}\n\n` +
      (refunded > 0
        ? `We refunded the full amount, ${money(refunded)}, to the card you paid with. Stripe says a refund usually shows within 5 to 10 business days.\n\n`
        : order.pilot_code ? "This was a pilot order, so there was nothing to pay or refund. Your pilot code can be used again.\n\n"
        : "Nothing was charged, so there is nothing to refund.\n\n") +
      "If you have a question, reply to this email.\n" + sign(env),
  };
}

function closedMail(env, order, role, first, unused, amount, credit) {
  const head = `Hello ${order.name},\n\n${role.title} (order ${order.id}) stopped appearing on InternScout on ${longDay(first)}, ` +
    "because the posting closed, moved to a new address or passed its deadline. So its paid listing has ended.\n\n";
  if (!credit) {
    return { to: order.email, replyTo: env.REVIEW_TO, subject: "Your InternScout listing has ended early",
      text: head + (order.pilot_code ? "It was a pilot listing, so there is nothing to refund.\n" : "There is nothing left to refund.\n") +
        "\nIf the role is open again at a new address, reply to this email.\n" + sign(env) };
  }
  const link = `${siteUrl(env)}/employers/buy/?credit=${credit.id}&t=${credit.token}`;
  const by = longDay(addDays((credit.offer_sent_at || credit.created).slice(0, 10), CREDIT_DEFAULT_DAYS));
  return {
    to: order.email, replyTo: env.REVIEW_TO,
    subject: "Your InternScout listing ended early: choose a refund or a credit",
    text: head + `${unused} of its ${DAYS} days were not used. They are worth ${money(amount)}. You can choose:\n\n` +
      `- a refund of ${money(amount)} to the card you paid with, or\n- a one-time promotion code worth ${money(amount)} for a future listing order.\n\n` +
      `Choose here: ${link}\n\nIf you do not choose by ${by}, we refund it.\n` + sign(env),
  };
}

function creditMail(env, order, credit, kind) {
  const text = kind === "credit"
    ? `Your promotion code is ${credit.promotion_code}\n\nIt is worth ${money(credit.amount)} off one future InternScout listing ` +
      "order and works once. Enter it on the Stripe payment page.\n"
    : (kind === "default" ? `You did not choose within ${CREDIT_DEFAULT_DAYS} days, so we refunded the unused days. ` : "") +
      `We refunded ${money(credit.amount)} to the card you paid with. Stripe says a refund usually shows within 5 to 10 business days.\n`;
  return {
    to: order.email, replyTo: env.REVIEW_TO,
    subject: kind === "credit" ? "Your InternScout promotion code" : "We refunded your unused InternScout listing days",
    text: `Hello ${order.name},\n\n${text}` + sign(env),
  };
}

export { approvedMail, closedMail, creditMail, receivedMail, refusedMail, reviewMail, verifyMail };
