import { bearerOf } from "./auth.js";
import { sessionUser, sessionTokenHash } from "./session.js";
import { canonicalFollow, normalizeFollowEmail } from "./follows.js";
import { admitFollowSignup } from "./follow-signup-admission.js";
import { createFollowSignupHttp } from "./follow-signup-http.js";

const unavailable = () => ({ status: "unavailable" });
// Shape validation only. Actual membership always uses the trusted current signup catalog below.
const shape = Object.fromEntries(
  ["companies", "fields", "states"].map((kind) => [kind, { has: () => true }]),
);

// Instantiate once per isolate, not once per request. No default origin, catalog URL or activation.
// loadCatalog closes over trusted first-party release pins; it receives no request or identity.
export function createFollowSignupRoute({
  enabled = false,
  originAllowed,
  loadCatalog,
  dailyLimit,
  clock = () => new Date(),
  timers,
} = {}) {
  return createFollowSignupHttp({
    enabled,
    originAllowed,
    timers,
    admit: async (input, request, context) => {
      const db = context?.db;
      if (
        !db ||
        typeof loadCatalog !== "function" ||
        typeof clock !== "function" ||
        !Number.isSafeInteger(dailyLimit) ||
        dailyLimit <= 0
      )
        return unavailable();
      try {
        normalizeFollowEmail(input.email);
        canonicalFollow(input.scope, shape);
      } catch {
        return { status: "invalid" };
      }
      try {
        let latest = -Infinity;
        const fresh = () => {
          const at = clock();
          if (!(at instanceof Date) || !Number.isFinite(+at) || +at < latest) throw new Error();
          latest = +at;
          return new Date(latest);
        };
        let identity, token, sessionProof;
        const live = () =>
          !identity ||
          (typeof identity.user === "string" &&
            /^[a-f0-9]{64}$/.test(identity.user) &&
            typeof identity.expires === "string" &&
            Date.parse(identity.expires) > +fresh());
        if (input.link) {
          token = bearerOf(request);
          // sessionUser owns the exact session grammar and never accepts provider ID tokens.
          identity = await sessionUser(db, token, { now: +fresh(), refresh: false });
          if (!live()) return unavailable();
        }
        const loaded = await loadCatalog();
        fresh();
        if (!live() || loaded?.status !== "available" || !loaded.catalog?.signup)
          return unavailable();
        if (identity) {
          sessionProof = { id: await sessionTokenHash(token), user: identity.user };
          if (!live()) return unavailable();
        }
        return await admitFollowSignup(db, input, {
          enabled: true,
          dailyLimit,
          catalog: loaded.catalog.signup,
          sessionProof,
          clock: () => {
            const at = fresh();
            if (identity && !(Date.parse(identity.expires) > +at)) throw new Error();
            return at;
          },
        });
      } catch {
        return unavailable();
      }
    },
  });
}
