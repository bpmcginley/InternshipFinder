// The Deep Dive's quick start (2026-10-04): sign in, add a resume, and Auto-Apply can be turned on from
// the Files step. Quick facts, Interview and Voice stay in the Deep Dive as optional extras that make the
// answers better. Kept out of onboarding.js, which needs a page to run, so the tests can load it.
import { hasKey, resumeReviewPending, manualDetailsMissing } from "../lib/store.js";

// A replaced resume must finish reading/review before either finish button enables
// Auto-Apply. Older profiles without a reading marker retain their existing setup.
// Sign-in itself is checked on the first AI call, as everywhere else.
export const quickStartReady = (S) => !!(hasKey(S) && S.files.resume && S.settings.signup_email && !resumeReviewPending(S));

// The way past a resume the AI couldn't read (or wasn't asked to): the student types their details on
// Quick facts instead. Auto-Apply stays paused until first name, last name and email are there
// (store.js manualDetailsMissing). A later successful read clears the manual flag.
// was: only a successful AI read set resume_details_ready, so a failed read left no way to turn Auto-Apply on.
export function enterDetailsManually(S) {
  S.settings.resume_import = null;
  S.settings.resume_details_ready = true;
  S.settings.resume_details_manual = true;
  return S;
}
// Whether to offer "I'll enter my details myself": a resume is there, it isn't being read or reviewed
// right now, and its details were never saved.
export const manualPathOpen = (S, { extracting = false, pending = false } = {}) =>
  !!S.files.resume && !extracting && !pending && !S.settings.resume_import && S.settings.resume_details_ready === false;

const NAMES = { first_name: "first name", last_name: "last name", email: "email" };
const list = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
// Why Auto-Apply is paused, in one or two plain sentences (Files step, Review).
export function pausedMessage(S) {
  const missing = manualDetailsMissing(S);
  if (!S.files.resume) return "Add your resume above, then read it and save its details. Auto-Apply starts when you do.";
  if (S.settings.resume_import) return "Review the resume updates above and save them. Auto-Apply starts when you do.";
  if (S.settings.resume_details_ready === false) return "Your resume details aren't saved yet. Read your resume above, or enter your details yourself in Quick facts. Auto-Apply starts when one of these is done.";
  if (missing.length) return `Add your ${list(missing.map((k) => NAMES[k]))} in Quick facts. Auto-Apply starts when they are filled in.`;
  return "";
}

// What finishing the Deep Dive does, from either button (Files' quick start, Review's finish): Auto-Apply
// is on (background/index.js checks onboarded), the date is kept for the side panel, and the next Deep
// Dive is a new run on the Worker. `save` is onboarding.js's save(now).
export async function finishOnboarding(S, save, now = Date.now()) {
  if (!quickStartReady(S)) throw new Error(pausedMessage(S) || "Set up the AI and add your application email before turning on Auto-Apply.");
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

// The "Ready to apply" card on the Files step (D28, 2026-10-14 design review). It appears under the
// resume slots after a read or a save, often below the fold, and students missed it. When it turns
// ready while the student is on the page (not when they arrive on Files with it already there, which
// keeps the step heading's focus), it is scrolled into view and its button takes focus.
// `was` is the card's last state on this visit to the step: null before the first draw.
export const shouldRevealQuick = (was, now) => was === false && now === true;
export function revealQuick(box, button, reduceMotion = false) {
  if (!box || !button) return;
  box.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  button.focus({ preventScroll: true });
}
