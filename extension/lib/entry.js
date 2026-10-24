// What the popup and the side panel offer for setup, in one place so the two say the same thing (D27, D29,
// 2026-10-14 design review). The setup that matters takes about two minutes (sign in, add a resume), so
// the entry button says that. "Deep Dive" is kept for the optional Interview and Voice steps only; it used
// to name every entry point ("Start Deep Dive"), which sounded long and optional.
// The "Leave a review" link and the button to reopen setup stay hidden until setup is finished: asking
// for a review before first use, or offering to "redo" something never done, made no sense.
import { hasKey, hasLocalResume, resumeReviewPending, manualDetailsMissing } from "./store.js";

export const SETUP_LABEL = "Set up Auto-Apply (about 2 minutes)";
export const EDIT_LABEL = "Edit setup";
export const REVIEW_RESUME_LABEL = "Review my resume";
export const ADD_DETAILS_LABEL = "Add my details";

// stage: "setup" (not finished), "paused" (a replaced resume waits for review), "ready".
export function entryState(s) {
  const onboarded = !!(s && s.settings && s.settings.onboarded);
  if (!onboarded || !hasKey(s)) {
    return { stage: "setup", label: SETUP_LABEL, note: "Set up Auto-Apply to start applying. It takes about 2 minutes: sign in and add your resume.", showReview: onboarded, showEdit: false };
  }
  // resumeReviewPending also covers "I'll enter my details myself" with a name or email still blank (#98);
  // that student has no new resume to review, so the card asks for the details instead.
  // was (2026-10-14, #110): every paused student was told to finish reviewing a new resume.
  if (manualDetailsMissing(s).length) {
    return { stage: "paused", label: ADD_DETAILS_LABEL, note: "Auto-Apply is paused until you add your name and email in setup.", showReview: true, showEdit: true };
  }
  // 2026-10-23: files stay on each device, even after a completed profile is restored (EXT-5).
  // was: a missing local resume reached ready. Revert: remove this separate missing-file state.
  if (!hasLocalResume(s)) {
    return { stage: "paused", label: "Add my resume", note: "Add your resume on this device in setup before using Auto-Apply. Your saved profile details are still here.", showReview: true, showEdit: true };
  }
  if (resumeReviewPending(s)) {
    return { stage: "paused", label: REVIEW_RESUME_LABEL, note: "Auto-Apply is paused until you finish reviewing your new resume.", showReview: true, showEdit: true };
  }
  return { stage: "ready", label: EDIT_LABEL, note: "", showReview: true, showEdit: true };
}
