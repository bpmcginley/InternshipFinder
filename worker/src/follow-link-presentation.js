import { canonicalFollow } from "./follows.js";
import { WORKER_URL } from "./public-config.js";

const SITE = "https://internscout.org";
const TOKEN = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.[a-f0-9]{64}$/;
const CONTROL = /[\x00-\x1f\x7f\ud800-\udfff]/u;
const ENCODER = new TextEncoder();
const fail = () => {
  throw new Error("Follow link presentation unavailable");
};

function labelMap(source) {
  if (!(source instanceof Map) || source.size > 10000) fail();
  const copy = new Map();
  for (const [key, label] of source) {
    if (
      typeof key !== "string" ||
      !key ||
      ENCODER.encode(key).length > 200 ||
      typeof label !== "string" ||
      !label ||
      label !== label.trim() ||
      label.length > 200 ||
      CONTROL.test(label)
    )
      fail();
    copy.set(key, label);
  }
  return copy;
}

function token(value, prefix = "") {
  if (
    typeof value !== "string" ||
    value.length !== 101 + prefix.length ||
    !value.startsWith(prefix) ||
    !TOKEN.test(value.slice(prefix.length))
  )
    fail();
  return value;
}

function unsubscribeLink(value) {
  return `${WORKER_URL}/follows/unsubscribe?token=${token(value)}`;
}

function scopeSummary(scopeKey, labels) {
  if (typeof scopeKey !== "string" || scopeKey.length > 4096 || ENCODER.encode(scopeKey).length > 4096)
    fail();
  let scope;
  try {
    scope = JSON.parse(scopeKey);
    if (canonicalFollow(scope, labels) !== scopeKey) fail();
  } catch {
    fail();
  }
  if (scope.kind === "company") return labels.companies.get(scope.company);

  const describe = (keys, kind, unrestricted) =>
    keys.map((key) => labels[kind].get(key)).join(", ") || unrestricted;
  const fields = describe(scope.fields, "fields", "all fields");
  const states = describe(scope.states, "states", "anywhere");
  const summary = `${fields}; ${states}`;
  if (summary.length <= 500) return summary;
  // The renderer accepts at most 500 characters. Keep broad valid scopes readable.
  const count = (keys, noun, unrestricted) =>
    keys.length ? `${keys.length} ${noun}${keys.length === 1 ? "" : "s"}` : unrestricted;
  return `${count(scope.fields, "field", "all fields")}; ${count(scope.states, "state", "anywhere")}`;
}

// The caller supplies labels from independently qualified public catalog data and
// an approved sender and postal address. No request origin or credentials configure URLs.
export function createFollowLinkPresentation({ from, postalAddress, labels } = {}) {
  if (
    typeof from !== "string" ||
    !from.trim() ||
    from.length > 512 ||
    typeof postalAddress !== "string" ||
    !postalAddress.trim() ||
    postalAddress.length > 500
  )
    fail();
  const catalog = {
    companies: labelMap(labels?.companies),
    fields: labelMap(labels?.fields),
    states: labelMap(labels?.states),
  };
  const presentation = Object.freeze({
    from,
    postalAddress,
    origins: Object.freeze([SITE, WORKER_URL]),
  });
  return Object.freeze({
    confirmation: Object.freeze({
      present({ scopeKey, confirmation, deleteRequest, unsubscribe }) {
        if (
          confirmation === unsubscribe ||
          deleteRequest === `fd_${confirmation}` ||
          deleteRequest === `fd_${unsubscribe}`
        )
          fail();
        return {
          ...presentation,
          summary: scopeSummary(scopeKey, catalog),
          links: {
            confirmation: `${SITE}/follows/action.html#purpose=confirm&token=${token(confirmation)}`,
            deleteRequest: `${SITE}/follows/action.html#purpose=delete-request&token=${token(deleteRequest, "fd_")}`,
            unsubscribe: unsubscribeLink(unsubscribe),
          },
        };
      },
    }),
    management: Object.freeze({
      presentation,
      buildLinks({ management, unsubscribe }) {
        if (management === unsubscribe) fail();
        return {
          management: `${SITE}/follows/manage.html#token=${token(management)}`,
          unsubscribe: unsubscribeLink(unsubscribe),
        };
      },
    }),
  });
}
