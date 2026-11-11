import { profileForModel } from "../lib/store.js";

const RULES = `You are InternScout's application agent. You operate a real browser tab to complete an internship application for the candidate below, one page at a time, up to but NEVER including the final submission.

HOW IT WORKS
- Each turn you get a SNAPSHOT: fields ([ref] kind *required "label" = current value, options), buttons, headings, errors. Act with tools using refs from the LATEST snapshot. You may call several tools in one turn; they run in order, then you get a fresh snapshot.
- Contact fields may already be filled by a fast pre-fill; check values and fix anything wrong.

FILLING
- Fill every field the profile supports, required and optional. Leave optional fields blank only when nothing in the profile fits.
- Use the candidate's real facts only. Never invent employers, dates, GPAs, awards, skills, or links. If a REQUIRED answer is missing and cannot be reasonably derived, call ask_user (one clear question).
- Choice fields (select, react_select, listbox, combobox, radio_group): pass the option text that matches the profile's meaning. If a select fails, the result lists real options; retry with one of them. A react_select marked searchable loads options from a search (school, city, discipline): pass the full proper name, e.g. the school's official name.
- Work authorization and visa sponsorship are different questions. Read each label carefully.
- EEO / demographic / veteran / disability questions: use the profile facts (default "decline to self-identify").
- Dates: match the field format (type=date needs YYYY-MM-DD; month/year splits need separate values).
- Uploads: use upload with resume for resume/CV fields; cv, transcript, cover_letter when those files exist. If a cover letter file is required but missing and there is a text box, write one instead.
- Free-text questions (why this company, describe a project, cover letter text, additional info): write in the candidate's VOICE, grounded in their stories/experience and the job description. Specific, honest, plain, no clichés or filler. Default 80-180 words; respect any character or word limit. Never mention being an AI.

NAVIGATION
- On a job description page, click Apply / Apply now / I'm interested.
- On Workday prefer "Apply Manually" (or "Autofill with Resume" only if manual is absent). After finishing a page click Next / Continue / Save and Continue.
- "Add" buttons (Add Work Experience, Add Education) open sub-forms; add the candidate's entries (most recent first, at most 3 jobs and all current schools).
- If validation errors appear, fix them before moving on.

ACCOUNTS
- If the site needs an account, follow the ACCOUNT line: sign in if one exists, otherwise create one with the given email. Use fill_secret for EVERY password and confirm-password field; never type a password with fill. Tick required account terms/privacy checkboxes.
- Always take the email route ("Sign in with email", "Use your email"), never "Sign in with Google/Apple/LinkedIn/Facebook". Those need the student's own Google or Apple password, which InternScout does not have and must never ask for, and they open the provider's own window where nothing here can follow.
- Email verification, SMS or 2FA → pause_for_user with a short instruction.
- CAPTCHA PRESENT on a form: it is the human's to solve at submit time. Fill everything else, then call ready_to_submit and put "solve the CAPTCHA" in double_check. Only pause_for_user if the CAPTCHA must be solved before you can continue (e.g. before Next or Sign in).

FINISHING
- The final submit button is reserved for the human and is blocked in code. Buttons marked BLOCKED must not be clicked.
- The final button is not always called Submit. Once the application has answers in it, a button saying Apply, Send, Finish, Done or Confirm on the last page or a review page is the final one: never click it, call ready_to_submit.
- An empty or unconfirmed factual profile value is UNKNOWN. Ask the student for required eligibility answers; never infer authorization, sponsorship, citizenship, age, or consent from a resume or other facts.
- When all pages are complete and only final submission remains (review page, or the last page whose main button is Submit), call ready_to_submit with a one-line summary and anything worth double-checking.
- If stuck (same page three times with no progress, broken widget, site error, page not an application), call pause_for_user and say what the human should do.
Keep any text outside tool calls to one short line.`;

export const TOOLS = [
  { name: "fill", description: "Type text into a text/textarea/rich_text field (also works for choice fields by option text).",
    input_schema: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" } }, required: ["ref", "text"] } },
  { name: "select", description: "Choose an option in a select, react_select, listbox, combobox or radio_group by visible option text.",
    input_schema: { type: "object", properties: { ref: { type: "string" }, option: { type: "string" } }, required: ["ref", "option"] } },
  { name: "check", description: "Set a checkbox on or off.",
    input_schema: { type: "object", properties: { ref: { type: "string" }, checked: { type: "boolean" } }, required: ["ref", "checked"] } },
  { name: "upload", description: "Attach one of the candidate's saved files to a file field.",
    input_schema: { type: "object", properties: { ref: { type: "string" }, file: { type: "string", enum: ["resume", "cv", "transcript", "cover_letter"] } }, required: ["ref", "file"] } },
  { name: "click", description: "Click a button or link (Apply, Next, Continue, Add, Sign in, Create account). Final submit buttons are blocked.",
    input_schema: { type: "object", properties: { ref: { type: "string" } }, required: ["ref"] } },
  { name: "fill_secret", description: "Fill a password or confirm-password field with the stored account password for this site. The password is never shown to you.",
    input_schema: { type: "object", properties: { ref: { type: "string" }, secret: { type: "string", enum: ["account_password"] } }, required: ["ref", "secret"] } },
  { name: "wait", description: "Wait for the page to load or a spinner to finish.",
    input_schema: { type: "object", properties: { seconds: { type: "number" } }, required: ["seconds"] } },
  { name: "ask_user", description: "Ask the human for a missing fact needed to answer a required question. The job pauses until they answer.",
    input_schema: { type: "object", properties: { question: { type: "string" }, why: { type: "string" } }, required: ["question"] } },
  { name: "pause_for_user", description: "Hand control to the human (CAPTCHA, email verification, 2FA, broken page, anything you cannot do).",
    input_schema: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } },
  { name: "ready_to_submit", description: "Everything is filled and only the final submit remains. Ends the run.",
    input_schema: { type: "object", properties: { summary: { type: "string" }, double_check: { type: "array", items: { type: "string" } } }, required: ["summary"] } },
];

// Old snapshots are the bulk of the context; keep only the latest (was: the last two). The tool
// results after each step already say what was filled and what failed, so the page before this one
// only repeated fields the model had seen, at full price on every later step of the run.
const KEEP_SNAPSHOTS = 1;
// Tool results from before the last two model turns are cut to "ok" or the start of the error
// (2026-10-04). A failed select returns every real option, and act() echoes back what it set, so old
// results were the next-largest thing re-sent at full price on every step. Each tool_result keeps its
// tool_use_id, so every tool call still has its answer and the request stays valid.
const KEEP_RESULT_TURNS = 2;
function shortResult(b) {
  const raw = typeof b.content === "string" ? b.content : JSON.stringify(b.content);
  if (!b.is_error) {
    // A human's answer to ask_user, and the other short notes, are plain strings worth keeping;
    // what act() returns is a JSON object, and only the fact that it worked matters later.
    try { const o = JSON.parse(raw); if (o && typeof o === "object") return "ok"; } catch (e) {}
    return raw;
  }
  if (raw.startsWith("failed: ")) return raw;   // already trimmed on an earlier step
  let err = raw;
  try { const o = JSON.parse(raw); if (o && typeof o === "object") err = String(o.error || o.message || raw); } catch (e) {}
  return "failed: " + err.slice(0, 120);
}
export function trimHistory(msgs) {
  let seen = 0, turns = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "assistant") { turns++; continue; }
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "text" && b.text.startsWith("SNAPSHOT")) {
        seen++;
        if (seen > KEEP_SNAPSHOTS) b.text = "SNAPSHOT (older page state removed)";
      }
      // The results in a user message answer the assistant turn before it, so a message with two or
      // more assistant turns after it answers a turn older than the last two.
      if (b.type === "tool_result" && turns >= KEEP_RESULT_TURNS) b.content = shortResult(b);
    }
  }
}

export const toolResult = (id, content, isError) => ({ type: "tool_result", tool_use_id: id, content: typeof content === "string" ? content : JSON.stringify(content), ...(isError ? { is_error: true } : {}) });

// was: .slice(0, 5000). The description now sits in the fixed opening of every request (buildSystem),
// where after the first step it is read from Gemini's cache at a tenth of the price, so more of it
// costs little and grounds the free-text answers better.
function jobIntro(job) {
  return `JOB\nCompany: ${job.company}\nTitle: ${job.title}\nLocation: ${job.location || ""}\nApply URL: ${job.apply_url}\n` +
    `Description:\n${(job.description || "(read it from the page)").slice(0, 8000)}`;
}

// The part of every request that stays the same for a whole run: rules, the candidate, the job.
// Gemini 3.x serves a request's repeated opening from its cache (a tenth of the input price) only
// once that opening is about 4,096 tokens long. Rules, tools and profile came to roughly 3,000, so in
// September under 1% of Auto-Apply's 1.25M input tokens were cached and every step paid full price
// for the same text. The job used to open the first message instead (was: content.push(jobIntro(job))
// on the first turn), after the part the cache can match; here it lifts the fixed opening past the
// threshold. Nothing in it may change between steps of a run, or the cache misses from that point.
export function buildSystem(store, job) {
  return [
    { type: "text", text: RULES },
    { type: "text", text: `CANDIDATE PROFILE (JSON)\n${JSON.stringify(profileForModel(store))}` },
    { type: "text", text: jobIntro(job), cache_control: { type: "ephemeral" } },
  ];
}
