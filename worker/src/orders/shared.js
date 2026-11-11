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
