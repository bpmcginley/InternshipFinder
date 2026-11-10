import { HttpError } from "../http.js";

export const LISTING_ID = /^[0-9a-f]{16}$/;
export const CONTROL = /[\u0000-\u001F\u007F]/g;
export const bad = (field, message) => new HttpError(400, "bad_request", message, { field });
