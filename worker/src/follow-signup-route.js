import { bearerOf } from "./auth.js";
import { sessionUser, sessionTokenHash } from "./session.js";
import { canonicalFollow, normalizeFollowEmail } from "./follows.js";
import { admitFollowSignup } from "./follow-signup-admission.js";
import { createFollowSignupHttp } from "./follow-signup-http.js";
import { validFollowCatalogKey } from "./follow-catalog.js";

const unavailable = () => ({ status: "unavailable" });
// Shape validation only. Actual membership always uses the trusted current signup catalog below.
const shape = Object.fromEntries(
  ["companies", "fields", "states"].map((kind) => [
    kind,
    { has: (value) => validFollowCatalogKey(value, kind) },
  ]),
);

// Instantiate once per isolate, not once per request. No default origin, catalog URL or activation.
// loadCatalog closes over trusted first-party release pins; it receives no request or identity.
export function createFollowSignupRoute({
  enabled = false,
  originAllowed,
  loadCatalog: defaultLoadCatalog,
  dailyLimit: defaultDailyLimit,
  clock: defaultClock = () => new Date(),
  timers,
} = {}) {
  return createFollowSignupHttp({
    enabled,
    originAllowed,
    timers,
    admit: async (input, request, context) => {
      const {
        db,
        loadCatalog = defaultLoadCatalog,
        dailyLimit = defaultDailyLimit,
        clock = defaultClock,
      } = context ?? {};
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
        fresh();
        const loaded = await loadCatalog();
        if (
          !live() ||
          loaded?.status !== "available" ||
          !loaded.catalog?.signup ||
          Object.keys(loaded).sort().join(",") !== "catalog,expiresAt,status"
        )
          return unavailable();
        // The trusted port binds this primitive cutoff to the same validated release snapshot.
        const { expiresAt } = loaded;
        if (
          !Number.isSafeInteger(expiresAt) ||
          expiresAt <= 0 ||
          !Number.isFinite(+new Date(expiresAt))
        )
          return unavailable();
        const admittedClock = () => {
          const at = fresh();
          if (+at >= expiresAt || (identity && !(Date.parse(identity.expires) > +at)))
            throw new Error();
          return at;
        };
        admittedClock();
        if (identity) {
          sessionProof = { id: await sessionTokenHash(token), user: identity.user };
          admittedClock();
        }
        return await admitFollowSignup(db, input, {
          enabled: true,
          dailyLimit,
          catalog: loaded.catalog.signup,
          catalogExpiresAtMs: expiresAt,
          sessionProof,
          clock: admittedClock,
        });
      } catch {
        return unavailable();
      }
    },
  });
}
