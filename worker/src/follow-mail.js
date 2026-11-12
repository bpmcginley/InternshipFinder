// Dormant follow templates and structured mail envelope. Callers supply approved sender details,
// trusted links and eligible public roles in their desired order.
import { addressOf } from "./mail.js";

const ROLE_ID = /^[a-f0-9]{16}$/;
const EMAIL = /^[^\s@<>,\x00-\x1f\x7f]+@[^\s@<>,\x00-\x1f\x7f]+\.[^\s@<>,\x00-\x1f\x7f]+$/;
const FOLLOW_TOKEN = /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.[a-f0-9]{64}/i;
const ACTION_TOKEN = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.[a-f0-9]{64}$/;
const invalid = () => {
  throw new Error("Invalid follow message input");
};

function line(value, limit) {
  if (typeof value !== "string" || value.length > limit) invalid();
  const text = value.replace(/[\s\x00-\x1f\x7f]+/g, " ").trim();
  if (!text) invalid();
  return text;
}

function mailAddress(value) {
  if (typeof value !== "string" || value.length > 254 || !EMAIL.test(value)) invalid();
  return value;
}

function postalLines(value) {
  if (typeof value !== "string" || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid();
  line(value, 500);
  return value.replace(/\r\n?/g, "\n").trim();
}

function link(value, httpsOnly = true) {
  if (
    typeof value !== "string" ||
    value.length > 2000 ||
    /[\s\x00-\x1f\x7f<>"\\]/.test(value) ||
    !(httpsOnly ? /^https:\/\/[^/]/i : /^https?:\/\/[^/]/i).test(value)
  )
    invalid();
  let url;
  try {
    url = new URL(value);
  } catch {
    invalid();
  }
  if (!url.hostname || /^https?:\/\/[^/?#]*@/i.test(value) || url.href.length > 2000) invalid();
  return url;
}

function decodedLink(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    invalid();
  }
}

// Only body action slots may use the landing page's canonical purpose-specific fragment.
function actionFragment(name, value, url) {
  const purpose =
    name === "confirmation" ? "confirm" : name === "deleteRequest" ? "delete-request" : null;
  if (!purpose) invalid();
  const prefix = `${url.origin}/follows/action.html#purpose=${purpose}&token=${purpose === "delete-request" ? "fd_" : ""}`;
  if (!value.startsWith(prefix) || !ACTION_TOKEN.test(value.slice(prefix.length))) invalid();
}

function trustedLinks(origins, links) {
  if (!Array.isArray(origins) || !origins.length || !links) invalid();
  const allowed = new Set(
    origins.map((value) => {
      const url = link(value);
      if (url.href !== `${url.origin}/`) invalid();
      return url.origin;
    }),
  );
  return (name, publicLink = false) => {
    const value = links[name];
    const url = link(value);
    if (!allowed.has(url.origin)) invalid();
    if (publicLink) {
      if (FOLLOW_TOKEN.test(decodedLink(url.href))) invalid();
    } else if (decodedLink(url.pathname) === "/follows/action.html" || value.includes("#"))
      actionFragment(name, value, url);
    return url.href;
  };
}

function roleLines(roles, seen, limit = Infinity) {
  if (!Array.isArray(roles)) invalid();
  const lines = [];
  for (const role of roles) {
    if (!role || typeof role.id !== "string" || !ROLE_ID.test(role.id)) invalid();
    if (seen.ids.has(role.id)) continue;
    const posting = link(role.apply_url, false);
    const identity = `${posting.origin}${posting.pathname}${posting.search}`;
    seen.ids.add(role.id);
    if (seen.urls.has(identity)) continue;
    seen.urls.add(identity);
    lines.push(
      `${line(role.company_name, 200)}: ${line(role.title, 300)} (${line(role.location, 300)})`,
      posting.href,
    );
    if (lines.length / 2 === limit) break;
  }
  return lines;
}

export function renderFollowMail(kind, input) {
  if (!input || !["confirm", "manage", "digest"].includes(kind)) invalid();
  const seen = { ids: new Set(), urls: new Set() };
  const matches = kind === "digest" ? roleLines(input.matches, seen) : [];
  if (kind === "digest" && !matches.length) return null;

  const { from, to, postalAddress, origins, links } = input;
  if (typeof from !== "string" || /[\x00-\x1f\x7f]/.test(from)) invalid();
  const sender = addressOf(from);
  mailAddress(typeof sender === "string" ? sender : sender.email);
  if (typeof sender !== "string") line(sender.name, 200);
  const envelope = { from: sender, to: mailAddress(to) };
  const url = trustedLinks(origins, links);
  const unsubscribe = url("unsubscribe");
  envelope.headers = {
    "List-Unsubscribe": `<${unsubscribe}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
  let subject, lines;
  if (kind === "confirm") {
    const deleteRequest = url("deleteRequest");
    const target = decodedLink(deleteRequest);
    const allFollows = decodedLink(unsubscribe);
    const unsubscribeToken = allFollows.match(FOLLOW_TOKEN)?.[0];
    if (target === allFollows || (unsubscribeToken && target.includes(unsubscribeToken))) invalid();
    subject = "Confirm your InternScout follows";
    lines = [
      `You asked for new internships matching ${line(input.summary, 500)}.`,
      `Confirm: ${url("confirmation")}`,
      "This link expires in 7 days. If you did not ask for this, ignore this email. We will delete the request after 7 days.",
      `Delete this request: ${deleteRequest}`,
    ];
  } else if (kind === "manage") {
    subject = "Manage your InternScout follows";
    lines = [
      `Manage your follows: ${url("management")}`,
      "This link expires in 30 minutes. If you did not request it, ignore this email.",
      `Unsubscribe: ${unsubscribe}`,
    ];
  } else {
    subject = "New internships for your follows";
    lines = ["New roles matching your follows:", ...matches];
    const similar = roleLines(input.similar ?? [], seen, 2);
    if (similar.length)
      lines.push(similar.length === 2 ? "One similar role:" : "Two similar roles:", ...similar);
    lines.push(
      `See matching roles: ${url("matchingPage", true)}`,
      `Share these roles: ${url("publicShare", true)}`,
      "Always check the employer's posting before applying.",
      `Manage my follows: ${url("management")}`,
      `Unsubscribe: ${unsubscribe}`,
    );
  }
  lines.push("InternScout", postalLines(postalAddress));
  return { ...envelope, subject, text: lines.join("\n") };
}

export async function sendFollowMail(env, kind, input) {
  const message = renderFollowMail(kind, input);
  if (!message) return null;
  if (typeof env.EMAIL?.send !== "function") throw new Error("Follow mail is unavailable");
  // Do not expose a provider's error details, which may include message or recipient data.
  try {
    return await env.EMAIL.send(message);
  } catch {
    throw new Error("Follow mail attempt failed");
  }
}
