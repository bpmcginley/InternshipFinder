// The Deep Dive's quick start (2026-10-04): sign in, add a resume, and Auto-Apply can be turned on from
// the Files step. Quick facts, Interview and Voice stay in the Deep Dive as optional extras that make the
// answers better. Kept out of onboarding.js, which needs a page to run, so the tests can load it.
import { hasKey, resumeReviewPending } from "../lib/store.js";

// A replaced resume must finish reading/review before either finish button enables
// Auto-Apply. Older profiles without a reading marker retain their existing setup.
// Sign-in itself is checked on the first AI call, as everywhere else.
export const quickStartReady = (S) => !!(hasKey(S) && S.files.resume && S.settings.signup_email && !resumeReviewPending(S));

// What finishing the Deep Dive does, from either button (Files' quick start, Review's finish): Auto-Apply
// is on (background/index.js checks onboarded), the date is kept for the side panel, and the next Deep
// Dive is a new run on the Worker. `save` is onboarding.js's save(now).
export async function finishOnboarding(S, save, now = Date.now()) {
  if (!quickStartReady(S)) throw new Error("Finish reading and reviewing your resume, and add your application email before turning on Auto-Apply.");
  S.settings.onboarded = true;
  S.settings.deep_dive_at = now;
  S.settings.deep_dive_run = null;   // the next Deep Dive is a new run
  await save(true);
  return S;
}

// The weekly email, offered once setup is done (2026-10-06): one optional plain link under "Auto-Apply
// is on", on both finish screens. It opens the site's /digest/ page, whose form posts to the email
// provider; the extension itself never sees or sends an address. utm_source and utm_medium say it came
// from here, the Worker's "extension" source (worker/src/visits.js sourceOf). Ships with the next
// extension release; 0.5.5 was already in review.
export const DIGEST_URL = "https://internscout.org/digest/?utm_source=extension&utm_medium=extension";
// Off in 0.5.6 (2026-10-13): the digest is on hold and /digest/ says sign-ups aren't open, so the link
// would lead nowhere. Set true in the release after CONFIG.digest.formAction is set in docs/index.html.
export const DIGEST_OPEN = false;
export const digestLink = (open = DIGEST_OPEN) => !open ? "" :
  // A block span, not a <p>: Review puts it inside its #rstat <span>, where a <p> isn't allowed.
  `<span class="small" style="display:block;margin:6px 0 0"><a href="${DIGEST_URL}" target="_blank" rel="noopener">Get new internships by email every Monday ↗</a></span>`;
