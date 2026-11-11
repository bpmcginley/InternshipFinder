import { HttpError } from "../http.js";

export const LISTING_ID = /^[0-9a-f]{16}$/;
export const CONTROL = /[\u0000-\u001F\u007F]/g;
export const bad = (field, message) => new HttpError(400, "bad_request", message, { field });

export const LIMITS = { name: 100, email: 254, company: 120, pilot_code: 32, reason: 200, note: 200 };
export const conflict = (code, message, extra) => new HttpError(409, code, message, extra);

export function text(body, field, { required = false } = {}) {
  const v = body[field];
  if (v != null && typeof v !== "string") throw bad(field, `${field} must be text`);
  const s = (v || "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (required && !s) throw bad(field, `${field} is required`);
  if (s.length > LIMITS[field]) throw bad(field, `${field} is too long (at most ${LIMITS[field]} characters)`);
  return s;
}

export const DAYS = 30;              // days each role runs
export const FIELD_CAP = 5;          // paid roles running at once that share a field tag
export const MAX_START_DAYS = 90;    // the start day is today up to this many days ahead

// A verified order's roles hold their days this long after its Checkout opened (Checkout expires at 31
// minutes), so two buyers can't both pay for the last place in a field.
export const CHECKOUT_HOLD_MS = 35 * 60_000;

export const fieldsOf = (list) => (list.length ? list : ["other"]);

export const UNVERIFIED_DAYS = 7;    // an order never confirmed is deleted after this
export const CREDIT_DEFAULT_DAYS = 30;   // an unanswered unused-days offer becomes a refund after this

export const money = (cents) => "$" + (Number(cents || 0) / 100).toFixed(2);
export const rolesWord = (n) => (n === 1 ? "1 role" : `${n} roles`);

export const ORDER_ID = /^o-[0-9a-f]{16}$/;
