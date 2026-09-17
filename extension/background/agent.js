// The Auto-Apply loop: snapshot the page → Claude picks actions (tool use) → execute with
// verify-after-set → repeat, across page navigations, until ready_to_submit / needs_you.
import { callAI } from "./claude.js";
import { NEEDS_YOU_CODES } from "./gemini.js";
import { hasHostAccess, hostOf } from "../lib/hosts.js";
import { loadStore, updateStore, profileForModel, accountFor, domainOf, hasKey, isGemini, isWorker, modelFor } from "../lib/store.js";
import { ensureToken } from "../lib/auth.js";
import { tailorResume } from "./tailor.js";
import { canTailor } from "../lib/tailoring.js";
import { getJob, updateJob, appendLog, saveMsgs, loadMsgs } from "./queue.js";
import { spend, money } from "../lib/usage.js";
// Side-effect import: guard.js is an IIFE that hangs ISGuard off globalThis. We want detectGate
// here (in the worker) as well as in the page, and this keeps one copy with one set of tests.
import "../agent/guard.js";

const MAX_STEPS = 40;
const MAX_FIELD_FAILS = 3;
const PAGE_FILES = ["agent/guard.js", "agent/actions.js", "agent/dom.js"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
- Email verification, SMS or 2FA → pause_for_user with a short instruction.
- CAPTCHA PRESENT on a form: it is the human's to solve at submit time. Fill everything else, then call ready_to_submit and put "solve the CAPTCHA" in double_check. Only pause_for_user if the CAPTCHA must be solved before you can continue (e.g. before Next or Sign in).

FINISHING
- The final submit button is reserved for the human and is blocked in code. Buttons marked BLOCKED must not be clicked.
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

// ---------- tab + page plumbing ----------
async function ensureTab(job) {
  if (job.tabId) {
    const t = await chrome.tabs.get(job.tabId).catch(() => null);
    if (t) return t.id;
  }
  const t = await chrome.tabs.create({ url: job.apply_url, active: false });
  try {
    let { groupId } = await chrome.storage.session.get("groupId");
    if (groupId != null) await chrome.tabGroups.get(groupId).catch(() => { groupId = null; });
    groupId = await chrome.tabs.group(groupId != null ? { tabIds: [t.id], groupId } : { tabIds: [t.id] });
    await chrome.tabGroups.update(groupId, { title: "InternScout", color: "blue" });
    await chrome.storage.session.set({ groupId });
  } catch (e) { /* tab groups unsupported (e.g. Edge variants) */ }
  return t.id;
}

async function groupTab(tabId) {
  try {
    const { groupId } = await chrome.storage.session.get("groupId");
    if (groupId != null) await chrome.tabs.group({ tabIds: [tabId], groupId });
  } catch (e) { /* group gone or unsupported */ }
}

async function waitForTab(tabId, timeout = 25000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) throw new Error("The application tab was closed.");
    if (t.status === "complete") return t;
    await sleep(300);
  }
  return chrome.tabs.get(tabId);
}

async function inject(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", files: PAGE_FILES });
  } catch (e) {
    for (let attempt = 0; ; attempt++) {
      try {
        await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: PAGE_FILES });
        break;
      } catch (err) {
        // Chrome's own error page (network blip, site block): reload a couple of times before giving up.
        if (!/error page/i.test(err.message) || attempt >= 2) {
          throw /error page/i.test(err.message) ? new Error("The site showed a load error (it may block automated browsing or be down). Open the tab, then Retry.") : err;
        }
        await chrome.tabs.reload(tabId).catch(() => {});
        await sleep(3000);
        await waitForTab(tabId);
      }
    }
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["agent/guard.js", "agent/overlay.js"] });
  } catch (e) {}
}

async function inFrames(tabId, func, args = []) {
  try {
    const res = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", func, args });
    return res.filter((r) => r && r.result);
  } catch (e) {
    return [];
  }
}

async function act(tabId, fullRef, action, payload) {
  const [fid, local] = String(fullRef).split(":");
  try {
    const [r] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [Number(fid)] }, world: "MAIN",
      func: (ref, a, p) => (window.ISDom ? window.ISDom.act(ref, a, p) : { ok: false, error: "Page changed. Use the new snapshot." }),
      args: [local, action, payload],
    });
    return (r && r.result) || { ok: false, error: "No result (frame navigated?)" };
  } catch (e) {
    return { ok: false, error: "Could not reach the page: " + e.message };
  }
}

function formatSnapshot(frames, fails) {
  const index = {};
  const lines = [];
  let hasFinal = false;
  const top = frames.find((f) => f.frameId === 0) || frames[0];
  if (!top) return { text: "(page not readable yet)", index, top: null, hasFinal };
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
      index[ref] = { kind: e.kind, label: e.label || e.question || "" };
      let s = `[${ref}] ${e.kind}${e.type && e.type !== "text" ? `(${e.type})` : ""}${e.required ? " *" : ""} "${e.label}"`;
      if (e.question) s += ` in "${e.question}"`;
      s += ` = ${JSON.stringify(e.value === undefined ? "" : e.value)}`;
      if (e.options && e.options.length) s += ` options: ${e.options.join(" | ")}`;
      if (e.placeholder) s += ` placeholder=${JSON.stringify(e.placeholder)}`;
      if (e.maxlength) s += ` maxlength=${e.maxlength}`;
      if (e.error) s += ` ERROR: ${e.error}`;
      if ((fails[ref] || 0) >= MAX_FIELD_FAILS) s += " (failed 3 times: skip it or pause_for_user if required)";
      lines.push(s);
    }
    lines.push("BUTTONS:");
    for (const b of f.buttons) {
      const ref = `${f.frameId}:${b.ref}`;
      index[ref] = { kind: "button", label: b.text };
      if (b.blocked) hasFinal = true;
      lines.push(`[${ref}] "${b.text}"${b.blocked ? " BLOCKED (final submit, human only)" : ""}${b.menu === "open" ? " (menu already open: click one of its items, not this again)" : ""}`);
    }
    if (f.text) lines.push(`PAGE TEXT: ${f.text}`);
  }
  return { text: lines.join("\n"), index, top, hasFinal };
}

// A code sitting in your inbox is yours to fetch, so the agent stops there and hands the tab
// back. Checked here, before the model gets a turn, so the pause costs no AI call and does not
// depend on the model choosing to call pause_for_user.
const GATE_HELP = {
  email_verification: "This site emailed you a verification code. Enter it in the tab, then press Resume.",
  captcha: "The site wants you to prove you're human. Solve the check in the tab, then press Resume.",
};

function gateIn(frames) {
  for (const f of frames) {
    const g = globalThis.ISGuard.detectGate(f);
    if (g) return g;
  }
  return null;
}

// Old snapshots are the bulk of the context; keep only the last two.
function trimHistory(msgs) {
  let seen = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== "user" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === "text" && b.text.startsWith("SNAPSHOT")) {
        seen++;
        if (seen > 2) b.text = "SNAPSHOT (older page state removed)";
      }
    }
  }
}

const toolResult = (id, content, isError) => ({ type: "tool_result", tool_use_id: id, content: typeof content === "string" ? content : JSON.stringify(content), ...(isError ? { is_error: true } : {}) });

function jobIntro(job) {
  return `JOB\nCompany: ${job.company}\nTitle: ${job.title}\nLocation: ${job.location || ""}\nApply URL: ${job.apply_url}\n` +
    `Description:\n${(job.description || "(read it from the page)").slice(0, 5000)}`;
}

function accountLine(store, url) {
  const a = accountFor(store, url);
  return a.isNew
    ? `ACCOUNT (${a.domain}): none saved. If an account is required, create one with email ${a.email}.`
    : `ACCOUNT (${a.domain}): exists. Sign in with email ${a.email}; use fill_secret for the password.`;
}

// ---------- tailored resume ----------
async function tailorStep(id, job, store) {
  await updateJob(id, { activity: "Tailoring your resume to this posting…" });
  try {
    const { cost_usd, ...t } = await tailorResume(store, job);
    const auto = store.settings.tailor_resume === "auto";
    job = await updateJob(id, (j) => ({ tailored: { ...t, status: auto ? "approved" : "pending" }, cost_usd: (j.cost_usd || 0) + cost_usd }));
    await appendLog(id, { kind: "tailor", text: `Tailored resume: ${t.diff.length} change(s)${auto ? ", used automatically" : ""}.` });
    if (!auto) job = await updateJob(id, { status: "needs_you", reason: "Review the tailored resume: use it, or keep your original.", question: "", activity: "" });
  } catch (e) {
    const msg = String((e && e.message) || e);
    job = await updateJob(id, { tailored: { status: "failed", error: msg } });
    await appendLog(id, { kind: "tailor", text: `Couldn't tailor the resume (${e && e.code ? msg : msg.slice(0, 80)}). Using your original.` });
  }
  return job;
}

// ---------- main loop ----------
const running = new Set();
export const isRunning = (id) => running.has(id);

export async function runJob(id) {
  if (running.has(id)) return;
  running.add(id);
  try {
    await loop(id);
  } catch (e) {
    await updateJob(id, { status: "failed", reason: String((e && e.message) || e), activity: "" });
  } finally {
    running.delete(id);
  }
}

async function loop(id) {
  let job = await getJob(id);
  if (!job) return;
  let store = await loadStore();
  if (!hasKey(store)) {
    await updateJob(id, { status: "needs_you", reason: `Add your ${isGemini(store.ai) ? "Gemini" : "Anthropic"} API key (Deep Dive → Setup), then Resume.` });
    return;
  }
  if (isWorker(store.ai) && !(await ensureToken())) {
    await updateJob(id, { status: "needs_you", reason: "Sign in with Google or Microsoft (InternScout popup or Deep Dive → Setup), then Resume.", activity: "" });
    return;
  }
  // The manifest only covers the big applicant-tracking systems. An employer that runs its own careers
  // site needs the student's say-so, and Chrome only grants that from a click on an extension page, so
  // the side panel asks and this run waits. Checked before the tab opens: a tab we cannot script is
  // just a confusing window.
  if (!(await hasHostAccess(job.apply_url))) {
    await updateJob(id, { status: "needs_you", needs_host: job.apply_url, activity: "",
      reason: `InternScout needs your permission to work on ${hostOf(job.apply_url)}. Allow it below, then Resume.` });
    return;
  }
  // One Auto-Apply run = one allowance unit on the InternScout Worker; kept across Resume, reset by Retry.
  if (!job.run_id) job = await updateJob(id, { run_id: crypto.randomUUID() });
  if (!job.tailored && (store.settings.tailor_resume || "off") !== "off" && canTailor(store, job) && (isWorker(store.ai) || !(await spend()).over)) {
    job = await tailorStep(id, job, store);
    if (job.status !== "working") return; // waiting for the human to approve it
  }
  let tabId = await ensureTab(job);
  job = await updateJob(id, { tabId, status: "working", reason: "", question: "", needs_host: "" });
  const msgs = await loadMsgs(id);
  const fails = {};
  let pending = job.pending || null;
  let steps = job.steps || 0;

  while (true) {
    job = await getJob(id);
    if (!job || job.status !== "working") return;
    if (steps >= MAX_STEPS) {
      await updateJob(id, { status: "needs_you", reason: `Stopped after ${MAX_STEPS} steps. Finish by hand, or Resume to let it keep going.`, steps: 0, pending });
      await saveMsgs(id, msgs);
      return;
    }
    const sp = await spend();
    if (sp.over && !isWorker(store.ai)) {
      await updateJob(id, { status: "needs_you", reason: `Monthly AI budget reached (${money(sp.month_usd)} of ${money(sp.budget)}). Raise it in Deep Dive → Setup, then Resume.`, pending, activity: "" });
      await saveMsgs(id, msgs);
      return;
    }

    const cur = await waitForTab(tabId);
    // A redirect or a new tab can land on a site the student never allowed (company page -> external ATS).
    if (cur && cur.url && !(await hasHostAccess(cur.url))) {
      await updateJob(id, { status: "needs_you", needs_host: cur.url, pending, activity: "",
        reason: `The application moved to ${hostOf(cur.url)}. Allow InternScout there below, then Resume.` });
      await saveMsgs(id, msgs);
      return;
    }
    await sleep(800);
    await inject(tabId);
    store = await loadStore();
    const facts = { ...store.profile.facts, email: store.settings.signup_email || store.profile.facts.email };
    const pre = (await inFrames(tabId, (f) => window.ISDom && window.ISDom.fastFill(f), [facts])).flatMap((r) => r.result || []);

    let frames = (await inFrames(tabId, () => window.ISDom && window.ISDom.snapshot())).map((r) => ({ frameId: r.frameId, ...r.result }));
    if (!frames.some((f) => f.elements.length || f.buttons.length)) {
      await sleep(2500);
      await inject(tabId);
      frames = (await inFrames(tabId, () => window.ISDom && window.ISDom.snapshot())).map((r) => ({ frameId: r.frameId, ...r.result }));
    }
    // Single-page apps (Workday, Oracle, SuccessFactors) show a spinner for several seconds after the tab
    // reports "complete". A model turn spent on an empty loading page is wasted, so wait it out here.
    for (let i = 0; i < 4 && !frames.some((f) => f.elements.length) && frames.some((f) => f.busy); i++) {
      await sleep(2000);
      await inject(tabId);
      frames = (await inFrames(tabId, () => window.ISDom && window.ISDom.snapshot())).map((r) => ({ frameId: r.frameId, ...r.result }));
    }
    const snap = formatSnapshot(frames, fails);
    snap.tabId = tabId;
    const url = (snap.top && snap.top.url) || job.apply_url;

    const gate = gateIn(frames);
    if (gate) {
      await appendLog(job.id, { kind: "gate", text: `Paused: ${gate.reason}` });
      await updateJob(id, { status: "needs_you", reason: GATE_HELP[gate.kind], question: "", pending, activity: "" });
      await saveMsgs(id, msgs);
      return;
    }

    const content = [];
    if (pending && pending.results) content.push(...pending.results);
    if (!msgs.length) content.push({ type: "text", text: jobIntro(job) });
    if (pending && pending.note) content.push({ type: "text", text: pending.note });
    if (pre.length) content.push({ type: "text", text: `Pre-filled: ${pre.join("; ")}` });
    content.push({ type: "text", text: `SNAPSHOT\n${accountLine(store, url)}\n${snap.text}` });
    msgs.push({ role: "user", content });
    const prevPending = pending;
    pending = null;
    trimHistory(msgs);

    const system = [
      { type: "text", text: RULES },
      { type: "text", text: `CANDIDATE PROFILE (JSON)\n${JSON.stringify(profileForModel(store))}`, cache_control: { type: "ephemeral" } },
    ];
    let resp;
    try {
      resp = await callAI({ ai: store.ai, model: modelFor(store, "agent"), system, messages: msgs, tools: TOOLS, max_tokens: 8000, kind: "agent", run_id: job.run_id });
    } catch (e) {
      // Sign-in, allowance, rate or pause: hand the job to the student instead of failing it; Resume retries this step.
      if (!NEEDS_YOU_CODES.has(e && e.code)) throw e;
      msgs.pop();
      await updateJob(id, { status: "needs_you", reason: e.message, pending: prevPending, activity: "" });
      await saveMsgs(id, msgs);
      return;
    }
    msgs.push({ role: "assistant", content: resp.content });
    steps++;

    const uses = resp.content.filter((b) => b.type === "tool_use");
    const say = resp.content.filter((b) => b.type === "text").map((b) => b.text).join(" ").trim();
    await updateJob(id, (j) => ({ steps, activity: (say || uses.map((u) => u.name).join(", ")).slice(0, 160), cost_usd: (j.cost_usd || 0) + (resp.cost_usd || 0) }));

    if (!uses.length) {
      pending = { results: [], note: resp.stop_reason === "max_tokens"
        ? "Your reply was cut off. Use fewer, shorter tool calls per turn."
        : "Continue using the tools. If only the final submit remains, call ready_to_submit." };
      await updateJob(id, { pending });
      await saveMsgs(id, msgs);
      continue;
    }

    const results = [];
    let stop = null;
    for (const u of uses) {
      if (stop) { results.push(toolResult(u.id, "Not run: the job paused.")); continue; }
      if (tabId !== snap.tabId) { results.push(toolResult(u.id, "Not run: the application opened in a new tab. Continue from the new snapshot.")); continue; }
      const r = await execTool(u, { tabId, index: snap.index, hasFinal: snap.hasFinal, store, job, fails, url });
      if (r.newTab) {
        tabId = r.newTab;
        await groupTab(tabId);
        await updateJob(id, { tabId });
        await appendLog(job.id, { kind: "nav", text: "The site opened the application in a new tab; following it." });
      }
      if (r.stop) {
        stop = { ...r, id: u.id };
        if (r.content != null) results.push(toolResult(u.id, r.content));
        continue;
      }
      results.push(toolResult(u.id, r.content, r.isError));
    }

    if (!stop) {
      pending = { results };
      await updateJob(id, { pending });
      await saveMsgs(id, msgs);
      continue;
    }

    await saveMsgs(id, msgs);
    if (stop.kind === "ready") {
      const hl = (await inFrames(tabId, () => window.ISDom && window.ISDom.highlight())).map((r) => r.result);
      const missing = hl.reduce((n, h) => n + ((h && h.missing) || 0), 0);
      const dc = [...(stop.double_check || [])];
      if (missing) dc.unshift(`${missing} required field(s) look empty (amber outline).`);
      await updateJob(id, { status: "ready_to_submit", summary: stop.summary || "", double_check: dc, activity: "", pending: { results } });
      return;
    }
    const waitResults = results; // tool_result for the waiting tool is added on resume
    if (stop.kind === "ask") {
      await updateJob(id, { status: "needs_you", question: stop.question, reason: stop.why || "The agent needs an answer.", pending: { results: waitResults, waitId: stop.id }, activity: "" });
    } else {
      await updateJob(id, { status: "needs_you", reason: stop.reason, question: "", pending: { results: waitResults, waitId: stop.id }, activity: "" });
    }
    return;
  }
}

async function execTool(u, ctx) {
  const { name, input = {} } = u;
  const { tabId, index, store, job, fails } = ctx;
  const needsRef = ["fill", "select", "check", "upload", "click", "fill_secret"].includes(name);
  const t = needsRef ? index[input.ref] : null;
  if (needsRef && !t) return { content: `Unknown ref ${input.ref}. Use refs from the latest snapshot.`, isError: true };
  if (needsRef && (fails[input.ref] || 0) >= MAX_FIELD_FAILS) return { content: "This field already failed 3 times. Skip it, or pause_for_user if it is required.", isError: true };

  let r;
  switch (name) {
    case "fill":
      r = await act(tabId, input.ref, "fill", { text: String(input.text ?? "") });
      if (r.ok) await logAnswer(job, t.label, input.text, t.kind);
      break;
    case "select":
      r = await act(tabId, input.ref, "select", { option: String(input.option ?? "") });
      if (r.ok) await logAnswer(job, t.label, r.chosen || input.option, t.kind);
      break;
    case "check":
      r = await act(tabId, input.ref, "check", { checked: !!input.checked });
      break;
    case "upload": {
      const tailored = input.file === "resume" && job.tailored && job.tailored.status === "approved" && job.tailored.file;
      const file = tailored || store.files[input.file];
      if (!file || !file.b64) return { content: `No ${input.file} file saved. Skip unless required; if required, ask_user.`, isError: true };
      r = await act(tabId, input.ref, "upload", { file: { name: file.name, type: file.type, b64: file.b64 } });
      break;
    }
    case "fill_secret": {
      const tab = await chrome.tabs.get(tabId);
      const acct = accountFor(store, tab.url || ctx.url);
      r = await act(tabId, input.ref, "fill", { text: acct.password, secret: true });
      if (r.ok && acct.isNew) {
        const { isNew, ...saved } = acct;
        await updateStore((s) => { if (!s.accounts.some((a) => a.domain === saved.domain)) s.accounts.push(saved); });
        store.accounts.push(saved);
        await appendLog(job.id, { kind: "account", text: `Created login for ${saved.domain} (${saved.email})` });
      }
      delete r.value;
      break;
    }
    case "click": {
      // "Apply" links often carry target=_blank (Oracle, company career pages, iCIMS portals). The agent
      // would keep reading the old tab forever, so notice a tab this click opened and move to it.
      const opened = [];
      const onNew = (t) => { if (t.openerTabId === tabId) opened.push(t.id); };
      chrome.tabs.onCreated.addListener(onNew);
      try {
        r = await act(tabId, input.ref, "click", {});
        if (r.ok) { await sleep(1500); await waitForTab(tabId).catch(() => {}); }
      } finally {
        chrome.tabs.onCreated.removeListener(onNew);
      }
      if (r.blocked) return { content: `${r.error}. Do not click it. If everything else is complete, call ready_to_submit; otherwise keep filling fields.`, isError: true };
      const newTab = opened.length && (await chrome.tabs.get(opened[opened.length - 1]).catch(() => null));
      if (r.ok && newTab) return { content: { ...r, note: "Opened a new tab; the next snapshot is from that tab." }, newTab: newTab.id };
      break;
    }
    case "wait":
      await sleep(Math.min(10, Math.max(1, Number(input.seconds) || 2)) * 1000);
      return { content: "Waited." };
    case "ask_user":
      return { stop: true, kind: "ask", question: input.question, why: input.why };
    case "pause_for_user":
      return { stop: true, kind: "pause", reason: input.reason };
    case "ready_to_submit":
      // Guard against stopping early: with no blocked final button in view, push back once.
      if (!ctx.hasFinal && !fails.__earlyReady) {
        fails.__earlyReady = 1;
        return { content: "No final Submit button is visible yet, so the application is probably not finished. Click Apply / Next / Save and Continue to reach the last page. Call ready_to_submit again only if you are sure nothing is left.", isError: true };
      }
      return { stop: true, kind: "ready", summary: input.summary, double_check: input.double_check, content: "Marked ready. The human will review and submit." };
    default:
      return { content: `Unknown tool ${name}`, isError: true };
  }
  if (!r.ok) fails[input.ref] = (fails[input.ref] || 0) + 1;
  return { content: r, isError: !r.ok };
}

async function logAnswer(job, label, answer, kind) {
  const a = String(answer || "");
  if (!label || (!["textarea", "rich_text"].includes(kind) && a.length < 60 && !/\?/.test(label))) return;
  await appendLog(job.id, { kind: "answer", question: label, answer: a });
  await updateStore((s) => {
    s.answers = [...(s.answers || []), { jobId: job.id, company: job.company, title: job.title, question: label, answer: a, at: Date.now() }].slice(-500);
  });
}

// Resume after ask_user / pause_for_user / manual pause.
export async function resumeJob(id, answer) {
  const job = await getJob(id);
  if (!job) return;
  let pending = job.pending || { results: [] };
  if (pending.waitId) {
    const text = answer ? `The human answered: ${answer}` : "The human handled it. Continue from the new snapshot.";
    pending = { results: [...(pending.results || []), toolResult(pending.waitId, text)] };
    if (answer && job.question) await updateStore((s) => { s.profile.extra[job.question] = answer; });
  } else if (job.status === "ready_to_submit") {
    pending = { results: pending.results || [], note: "The human asked you to keep going: re-check the page for anything unfilled or wrong, then call ready_to_submit again." };
  }
  await updateJob(id, { status: "queued", pending, question: "", reason: "", steps: 0 });
}

export async function checkSubmitted(tabId) {
  const res = await inFrames(tabId, () => {
    const t = (document.body && document.body.innerText) || "";
    return /thank(s| you)[^.\n]{0,60}(appl|submi|interest)|application (has been |was )?(successfully )?(submitted|received|complete)|we('ve| have) received your application|successfully (applied|submitted)|you('ve| have) (successfully )?applied/i.test(t);
  });
  return res.some((r) => r.result === true);
}

export { domainOf };
