// Dormant follow templates and structured mail envelope. Callers supply approved sender details,
// trusted links and eligible public roles in their desired order.
import { addressOf } from "./mail.js";

const ROLE_ID = /^[a-f0-9]{16}$/;
const EMAIL = /^[^\s@<>,\x00-\x1f\x7f]+@[^\s@<>,\x00-\x1f\x7f]+\.[^\s@<>,\x00-\x1f\x7f]+$/;
const FOLLOW_TOKEN = /[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.[a-f0-9]{64}/i;
const ACTION_TOKEN = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.[a-f0-9]{64}$/;
const MANAGEMENT_ORIGIN = "https://internscout.org";
const MANAGEMENT_PATH = "/follows/manage.html";
const MANAGEMENT_PREFIX = `${MANAGEMENT_ORIGIN}${MANAGEMENT_PATH}#token=`;
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

// Capability characters are ASCII. Collapse nested percent escapes without reparsing the URL.
function normalizedLinkAscii(value) {
  const chars = [];
  for (const char of value) {
    chars.push(char);
    while (chars.length >= 3 && chars.at(-3) === "%") {
      const hex = chars.at(-2) + chars.at(-1);
      if (!/^[0-7][0-9a-f]$/i.test(hex)) break;
      chars.length -= 3;
      chars.push(String.fromCharCode(Number.parseInt(hex, 16)));
    }
  }
  return chars.join("").toLowerCase();
}

// Only body action slots may use the landing page's canonical purpose-specific fragment.
function actionFragment(name, value, url) {
  const purpose =
    name === "confirmation" ? "confirm" : name === "deleteRequest" ? "delete-request" : null;
  if (!purpose) invalid();
  const prefix = `${url.origin}/follows/action.html#purpose=${purpose}&token=${purpose === "delete-request" ? "fd_" : ""}`;
  if (!value.startsWith(prefix) || !ACTION_TOKEN.test(value.slice(prefix.length))) invalid();
}

function managementFragmentToken(value) {
  if (typeof value !== "string" || !value.startsWith(MANAGEMENT_PREFIX)) return null;
  const token = value.slice(MANAGEMENT_PREFIX.length);
  return ACTION_TOKEN.test(token) ? token : null;
}

function trustedLinks(origins, links, withManagement) {
  if (!Array.isArray(origins) || !origins.length || !links) invalid();
  const allowed = new Set(
    origins.map((value) => {
      const url = link(value);
      if (url.href !== `${url.origin}/`) invalid();
      return url.origin;
    }),
  );
  const management = withManagement ? links.management : undefined;
  const managementToken = managementFragmentToken(management);
  function urlFor(name, publicLink = false) {
    const value = name === "management" ? management : links[name];
    const url = link(value);
    if (!allowed.has(url.origin)) invalid();
    if (
      managementToken &&
      name !== "management" &&
      normalizedLinkAscii(url.href).includes(managementToken)
    )
      invalid();
    if (publicLink) {
      if (FOLLOW_TOKEN.test(decodedLink(url.href))) invalid();
    } else {
      const path = decodedLink(url.pathname);
      if (
        path === MANAGEMENT_PATH ||
        (name === "management" && (url.origin === MANAGEMENT_ORIGIN || value.includes("#")))
      ) {
        if (name !== "management" || !managementToken) invalid();
      } else if (path === "/follows/action.html" || value.includes("#")) {
        actionFragment(name, value, url);
      }
    }
    return url.href;
  }
  return { urlFor, managementToken };
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

function rejectManagementInRoleLinks(lines, managementToken) {
  for (let i = 1; i < lines.length; i += 2) {
    const url = new URL(lines[i]);
    if (
      (managementToken && normalizedLinkAscii(url.href).includes(managementToken)) ||
      (url.origin === MANAGEMENT_ORIGIN && normalizedLinkAscii(url.pathname) === MANAGEMENT_PATH)
    )
      invalid();
  }
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
  const { urlFor: url, managementToken } = trustedLinks(origins, links, kind !== "confirm");
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
    rejectManagementInRoleLinks(matches, managementToken);
    rejectManagementInRoleLinks(similar, managementToken);
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
