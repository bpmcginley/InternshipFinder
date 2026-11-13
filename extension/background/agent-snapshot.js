export const MAX_FIELD_FAILS = 3;

// A dropdown that already holds an answer only needs its option count: the model reads the value, and
// a full list of countries or schools repeated on every step was a large share of each snapshot. An
// empty one, or one that has failed, keeps its list, because those are the ones the model must choose for.
const LISTED_CHOICES = ["select", "react_select"];
const hasValue = (v) => v !== undefined && v !== null && v !== "" && v !== false;
// A native <select> whose placeholder option carries a value ("-1", "0") reads back as "Select One"
// (dom.js valueOf), yet it holds no answer and its real options are what the model needs. Close
// to the test dom.js uses to drop that option from the list, with a word boundary so "Selected" is an answer.
const PLACEHOLDER_VALUE = /^[-–—.\s]*(select|choose|please select)\b|^\s*--/i;
const answered = (v) => hasValue(v) && !PLACEHOLDER_VALUE.test(String(v));

export function formatSnapshot(frames, fails = {}) {
  const index = {};
  const lines = [];
  // Labels of fields this snapshot already shows with a value; see preFilledLine.
  const shown = new Set();
  let hasFinal = false;
  // Every blocked button seen, for consentOnly below.
  const blocked = [];
  // A frame whose heading or step indicator says review / confirm (guard.js pageContext).
  const reviewStep = frames.some((f) => f.reviewStep);
  const top = frames.find((f) => f.frameId === 0) || frames[0];
  if (!top) return { text: "(page not readable yet)", index, top: null, hasFinal, shown, reviewStep, consentOnly: false };
  lines.push(`URL: ${top.url}`, `TITLE: ${top.title}`);
  for (const f of frames) {
    if (f.frameId !== 0 && !f.elements.length && !f.buttons.length) continue;
    if (f.frameId !== 0) lines.push(`--- iframe: ${f.url}`);
    if (f.headings.length) lines.push(`HEADINGS: ${f.headings.join(" | ")}`);
    if (f.step) lines.push(`STEP: ${f.step}`);
    if (f.captcha) lines.push("CAPTCHA PRESENT");
    if (f.errors.length) lines.push(`ERRORS: ${f.errors.join(" | ")}`);
    lines.push("FIELDS:");
    if (!f.elements.length) lines.push("(none)");
    for (const e of f.elements) {
      const ref = `${f.frameId}:${e.ref}`;
      index[ref] = { kind: e.kind, label: e.label || e.question || "", url: f.url };
      let s = `[${ref}] ${e.kind}${e.type && e.type !== "text" ? `(${e.type})` : ""}${e.required ? " *" : ""} "${e.label}"`;
      if (e.question) s += ` in "${e.question}"`;
      s += ` = ${JSON.stringify(e.value === undefined ? "" : e.value)}`;
      if (answered(e.value) && e.label) shown.add(e.label);
      // was: every choice field listed all its options and its placeholder, filled or not.
      const brief = LISTED_CHOICES.includes(e.kind) && answered(e.value) && !fails[ref];
      if (e.options && e.options.length) s += brief ? ` (${e.options.length} options)` : ` options: ${e.options.join(" | ")}`;
      if (e.placeholder && !brief) s += ` placeholder=${JSON.stringify(e.placeholder)}`;
      if (e.maxlength) s += ` maxlength=${e.maxlength}`;
      if (e.error) s += ` ERROR: ${e.error}`;
      if ((fails[ref] || 0) >= MAX_FIELD_FAILS) s += " (failed 3 times: skip it or pause_for_user if required)";
      lines.push(s);
    }
    lines.push("BUTTONS:");
    for (const b of f.buttons) {
      const ref = `${f.frameId}:${b.ref}`;
      index[ref] = { kind: "button", label: b.text, url: f.url };
      if (b.blocked) { hasFinal = true; blocked.push(b); }
      lines.push(`[${ref}] "${b.text}"${b.blocked ? (b.consent ? " BLOCKED (asks the student to agree; human only)" : " BLOCKED (final submit, human only)") : ""}${b.menu === "open" ? " (menu already open: click one of its items, not this again)" : ""}`);
    }
    if (f.text) lines.push(`PAGE TEXT: ${f.text}`);
  }
  // The only buttons held back are bare Accept / I agree buttons (guard.js isConsent), and the page does
  // not say it is the review step: a page asking the student to agree to something, not a finished
  // application. The run pauses there rather than saying "Ready to submit" (PR #99, 2026-10-14).
  const consentOnly = !reviewStep && blocked.length > 0 && blocked.every((b) => b.consent);
  return { text: lines.join("\n"), index, top, hasFinal, shown, reviewStep, consentOnly };
}

// fastFill reports "Label = value" for each field it filled, and the snapshot right after it shows the
// same fields with the same values, so the line said everything twice. Name only what the snapshot
// does not show (a field that lost its value again, a file chip the page doesn't read back).
// was: `Pre-filled: ${pre.join("; ")}`
export function preFilledLine(pre, shown) {
  if (!pre.length) return "";
  const rest = pre.filter((p) => !shown.has(String(p).split(" = ")[0]));
  if (!rest.length) return `Pre-filled ${pre.length} field(s) from the profile; their values are in the snapshot.`;
  return `Pre-filled: ${rest.join("; ")}`;
}

// ---------- no-progress breaker ----------
// A run that keeps clicking a button that does nothing, or circles one page, spends a model turn on
// every pass until MAX_STEPS, and on the InternScout AI every turn is the student's allowance. Pause
// instead, before the next model call, once the page has come back identical three times running or
// one page has had twelve turns. Only a pause: nothing here clicks or submits anything.
// "One page" is the URL plus the step the page says it is on, because Workday keeps one URL for every
// step of its application and a long one would otherwise read as twelve turns on the same page.
export const SAME_SNAPSHOTS_MAX = 3;
export const TURNS_PER_PAGE_MAX = 12;
export const NO_PROGRESS_HELP = "The page isn't changing after several tries. Finish this step by hand, then press Resume.";
export const freshProgress = () => ({ stuckSame: 0, lastText: null, turnsHere: 0, lastUrl: null });
export function progressCheck(state, snapText, url, asleep = false) {
  const next = {
    // A sleeping tab answers with the same picture whatever happened; the sleepy gate in loop() owns that case.
    stuckSame: !asleep && snapText === state.lastText ? state.stuckSame + 1 : 0,
    lastText: snapText,
    turnsHere: url === state.lastUrl ? state.turnsHere + 1 : 0,
    lastUrl: url,
  };
  return { stop: next.stuckSame >= SAME_SNAPSHOTS_MAX || next.turnsHere >= TURNS_PER_PAGE_MAX, state: next };
}
export const pageKey = (url, frames) => [url, ...frames.map((f) => f.step || "").filter(Boolean)].join(" | ");
