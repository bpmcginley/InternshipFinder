// One AI call per job: reword the candidate's existing resume content toward the posting, check it,
// and hand back a file that looks like the resume the student uploaded.
//
// Three ways to build that file, tried in this order. Each one falls through to the next on any
// problem that is about the file (not about the account: a cap or a sign-in error stops here, since
// trying again would only hit it again):
//   1. Word original -> the same .docx with only the reworded bullets changed (lib/docx.js).
//   2. PDF original  -> a PDF drawn from a description of the original's own layout: its font family,
//      sizes, alignment, heading style, and every section in the student's order (lib/resume_doc.js,
//      lib/pdf_layout.js). Reading the layout is one extra AI call, made once per resume and kept.
//   3. Anything else -> the fixed template in lib/pdf.js, built from the profile. This was the only
//      path at first, and is unchanged; students said it threw away their formatting and dropped
//      sections the profile has no slot for (Leadership, Awards, Activities).
import { callAI, jsonOf } from "./claude.js";
import { NEEDS_YOU_CODES } from "./gemini.js";
import { modelFor } from "../lib/store.js";
import { renderResume, toB64 } from "../lib/pdf.js";
import { renderLayoutFit } from "../lib/pdf_layout.js";
import { applyDocTailoring, docTailorInput, layoutMatchesProfile, normalizeLayout } from "../lib/resume_doc.js";
import { DOCX_TYPE, applyDocxTailoring, bulletGroups, docxTailorInput, openDocx, saveDocx } from "../lib/docx.js";
import { applyTailoring, tailorInput } from "../lib/tailoring.js";
import { readTailored, tailorKey, writeTailored } from "../lib/tailor_cache.js";

const SYSTEM = `You tailor a student's resume to one job posting. You may ONLY:
- reword existing bullets so they use the posting's language, where that stays truthful;
- reorder bullets within a role (most relevant first) and reorder skills;
- leave out at most one clearly irrelevant bullet from a role that has 3 or more;
- write a 1-2 sentence summary that uses only facts in the profile.
Never add employers, titles, dates, tools, technologies, numbers, metrics, awards, coursework or responsibilities that are not already in the profile. Copy every number exactly. Keep bullets under 30 words, starting with a strong verb. Match the candidate's voice. If a bullet already fits, keep its text.

Reply with JSON only:
{"summary": "...",
 "experience": [{"i": <role index>, "bullets": [{"from": <original bullet index j>, "text": "..."}]}],
 "projects": [{"i": <project index>, "description": "..."}],
 "skills": {"technical": [...], "tools": [...], "soft": [...]},
 "changes": ["short note on each meaningful change and why it fits the posting"]}`;

// The rules shared by the two format-keeping paths. No summary is ever added: if the student's
// resume has none, the tailored one has none.
const RULES = `Never add employers, titles, dates, tools, technologies, numbers, metrics, awards, coursework or responsibilities that are not already on the resume. Copy every number exactly. Keep each bullet about as long as the one it replaces, because the page is laid out around it. Start bullets with a strong verb. Match the candidate's voice. If a bullet already fits the posting, leave it out of your reply. "under" is read-only context that says which role the bullets belong to.`;

const SYSTEM_DOC = `You tailor a student's resume to one job posting. The resume is given as JSON sections, in the student's own order. You may ONLY:
- reword existing bullets (and an entry's "text" paragraph) so they use the posting's language, where that stays truthful;
- reorder bullets within one entry, most relevant first;
- leave out at most one clearly irrelevant bullet from an entry that has 3 or more;
- in a section of kind "skills": reorder the items inside a line. Keep its label and every item exactly; add and remove nothing;
- in a section of kind "summary": reword its lines using only facts found elsewhere on the resume.
Lines in sections of kind "other" cannot be changed. Text may carry **bold** and *italic* marks; keep them around the same words.
${RULES}

Reply with JSON only, listing only what you changed:
{"entries": [{"s": <section>, "e": <entry>, "text": "...", "bullets": [{"from": <original bullet index j>, "text": "..."}]}],
 "lines": [{"s": <section>, "k": <line>, "text": "..."}],
 "changes": ["short note on each meaningful change and why it fits the posting"]}
When you list an entry's bullets, list every bullet you are keeping, in the new order.`;

const SYSTEM_DOCX = `You tailor a student's resume to one job posting. You are given the bullet groups of their Word resume; the rest of the file stays as it is. You may ONLY:
- reword existing bullets so they use the posting's language, where that stays truthful;
- reorder bullets within one group, most relevant first;
- leave out at most one clearly irrelevant bullet from a group that has 3 or more.
A group of short items (skills, coursework) may only be reordered. Plain text only.
${RULES}

Reply with JSON only, listing only the groups you changed:
{"groups": [{"g": <group>, "bullets": [{"from": <original bullet index j>, "text": "..."}]}],
 "changes": ["short note on each meaningful change and why it fits the posting"]}
When you list a group's bullets, list every bullet you are keeping, in the new order.`;

const SYSTEM_LAYOUT = `You transcribe a resume PDF into JSON so it can be redrawn looking the same. Copy every word exactly as printed: never fix, shorten, reorder or leave out anything, and never add anything. Mark bold text as **bold** and italic text as *italic*.

{"style": {
   "font": "serif" | "sans",            // Times, Garamond, Georgia, Cambria, Computer Modern = serif; Arial, Helvetica, Calibri = sans
   "body_size": <pt>, "name_size": <pt>, "heading_size": <pt>, "contact_size": <pt>,
   "name_align": "left"|"center"|"right", "contact_align": "left"|"center"|"right",
   "name_bold": true|false, "name_caps": true|false,
   "heading": {"caps": true|false, "bold": true|false, "rule": "below"|"above"|"none", "align": "left"|"center"},
   "bullet": "<the bullet character used, or - >", "bullet_indent": <pt from the left margin>,
   "margin_in": <left/right margin, inches>, "margin_top_in": <top margin, inches>,
   "line_gap": <line height as a multiple of font size, usually 1.1 to 1.3>,
   "accent": "<#rrggbb of coloured headings/name, or empty if black>",
   "page": "letter"|"a4", "pages": <number of pages>},
 "header": {"name": "...", "contact": ["one string per printed contact line, separators as printed"]},
 "sections": [{"title": "<heading as printed>",
   "lines": ["free lines directly under the heading, e.g. **Languages:** Python, Java"],
   "entries": [{"rows": [{"left": "**Employer** or school, as printed", "right": "text set against the right margin, e.g. dates or city"}],
                "text": "a paragraph under the rows, if any",
                "bullets": ["..."]}]}]}
An entry is one job, school, project or award: its header rows (usually 1 or 2), then its bullets. Sections with no entries use only "lines". Reply with the JSON only.`;

const baseName = (store) => {
  const f = store.profile.facts;
  return [f.first_name, f.last_name].filter(Boolean).join("_").replace(/[^\w-]/g, "") || "Tailored";
};
const jobText = (job) => `JOB\n${job.company} - ${job.title}\n${String(job.description).slice(0, 6000)}`;
const voiceOf = (store) => JSON.stringify({ career_goal: store.profile.goals.career, voice: store.profile.voice.summary });
const changesOf = (out) => (Array.isArray(out && out.changes) ? out.changes : []).slice(0, 8).map(String);
const isAccountError = (e) => NEEDS_YOU_CODES.has(e && e.code);

// One cached, checked AI call. build(out) turns the model's JSON into {bytes, name, type, diff} or
// null when nothing usable came back.
async function tailorWith(store, job, system, prompt, build, extra) {
  const model = modelFor(store, "tailor");
  const key = await tailorKey(model, system, prompt);
  const hit = await readTailored(key);
  if (hit) return { ...hit, cost_usd: 0, reused: true };
  const resp = await callAI({ ai: store.ai, model, kind: "tailor", run_id: job.run_id, max_tokens: 4000, system, messages: [{ role: "user", content: prompt }] });
  const out = jsonOf(resp);
  const made = await build(out);
  if (!made) return null;
  const tailored = {
    file: { name: made.name, type: made.type, size: made.bytes.length, b64: toB64(made.bytes) },
    summary: made.summary || "",
    changes: changesOf(out),
    diff: made.diff,
    created: Date.now(),
    ...extra,
  };
  await writeTailored(key, tailored);
  return { ...tailored, cost_usd: resp.cost_usd || 0 };
}

// ---------- 1. Word original, edited in place ----------
async function tailorDocx(store, job, orig) {
  const opened = await openDocx(orig.b64);
  const parsed = bulletGroups(opened.xml);
  if (parsed.groups.reduce((n, g) => n + g.items.length, 0) < 3) return null; // not a bulleted resume we can read
  const prompt = `${jobText(job)}\n\nCANDIDATE\n${voiceOf(store)}\n\nRESUME BULLET GROUPS (JSON)\n${JSON.stringify(docxTailorInput(parsed))}`;
  return tailorWith(store, job, SYSTEM_DOCX, prompt, async (out) => {
    const { xml, diff } = applyDocxTailoring(opened.xml, parsed, out);
    const bytes = await saveDocx(opened, xml);
    return { bytes, diff, name: `${baseName(store)}_Resume.docx`, type: DOCX_TYPE };
  }, { format: "docx", note: "This is your own Word file with only the bullets below changed. Open it to check it still fits the page." });
}

// ---------- 2. PDF original, redrawn from its own layout ----------
const LAYOUT_KEY = "resume_layout"; // its own storage key, like tailor_cache: never races the big store write
const MAX_PDF_B64 = 1_200_000;      // the Worker refuses a resume_tailor body over 1.5 MB

async function fingerprint(file) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${SYSTEM_LAYOUT.length}:${file.b64}`));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The layout of one uploaded resume, read once. A resume that could not be read is remembered too
// ({doc: null}), so an unreadable scan costs one call, not one call per application.
async function layoutOf(store, job, orig) {
  const fp = await fingerprint(orig);
  let saved = null;
  try { saved = (await chrome.storage.local.get(LAYOUT_KEY))[LAYOUT_KEY]; } catch { /* read it again below */ }
  if (saved && saved.fp === fp) return { doc: saved.doc, cost_usd: 0 };
  const resp = await callAI({
    ai: store.ai, model: modelFor(store, "tailor"), kind: "tailor", run_id: job.run_id, max_tokens: 6000, system: SYSTEM_LAYOUT,
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: orig.b64 }, title: "Resume" },
      { type: "text", text: "Transcribe this resume into the JSON described. JSON only." },
    ] }],
  });
  let doc = null;
  try { doc = normalizeLayout(jsonOf(resp)); } catch { doc = null; }
  if (doc && !layoutMatchesProfile(doc, store)) doc = null;
  try { await chrome.storage.local.set({ [LAYOUT_KEY]: { fp, doc, created: Date.now() } }); } catch { /* costs a call next time, nothing else */ }
  return { doc, cost_usd: resp.cost_usd || 0 };
}

async function tailorPdf(store, job, orig) {
  if (orig.b64.length > MAX_PDF_B64) return null;
  const { doc, cost_usd } = await layoutOf(store, job, orig);
  if (!doc) return cost_usd ? { fallthrough_cost: cost_usd } : null;
  const prompt = `${jobText(job)}\n\nCANDIDATE\n${voiceOf(store)}\n\nRESUME (JSON)\n${JSON.stringify(docTailorInput(doc))}`;
  const made = await tailorWith(store, job, SYSTEM_DOC, prompt, async (out) => {
    const applied = applyDocTailoring(doc, out);
    const { bytes } = renderLayoutFit(applied.doc);
    return { bytes, diff: applied.diff, name: `${baseName(store)}_Resume.pdf`, type: "application/pdf" };
  }, { format: "pdf_layout", note: "Rebuilt to match your PDF's layout. Preview it and check names and dates before using it." });
  return made ? { ...made, cost_usd: (made.cost_usd || 0) + cost_usd } : { fallthrough_cost: cost_usd };
}

// ---------- 3. The fixed template, from the profile (the original path, unchanged) ----------
async function tailorFromProfile(store, job) {
  const model = modelFor(store, "tailor");
  const prompt = `JOB\n${job.company} - ${job.title}\n${String(job.description).slice(0, 6000)}\n\nPROFILE (JSON)\n${JSON.stringify(tailorInput(store))}`;
  const key = await tailorKey(model, SYSTEM, prompt);
  const hit = await readTailored(key);
  if (hit) return { ...hit, cost_usd: 0, reused: true };

  const resp = await callAI({
    ai: store.ai, model, kind: "tailor", run_id: job.run_id, max_tokens: 4000, system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  const out = jsonOf(resp);
  const { resume, diff } = applyTailoring(store, out);
  const bytes = renderResume(resume);
  const f = store.profile.facts;
  const base = [f.first_name, f.last_name].filter(Boolean).join("_").replace(/[^\w-]/g, "") || "Tailored";
  const tailored = {
    file: { name: `${base}_Resume.pdf`, type: "application/pdf", size: bytes.length, b64: toB64(bytes) },
    summary: resume.summary,
    changes: (Array.isArray(out.changes) ? out.changes : []).slice(0, 8).map(String),
    diff,
    created: Date.now(),
  };
  await writeTailored(key, tailored);
  return { ...tailored, cost_usd: resp.cost_usd || 0 };
}

export async function tailorResume(store, job) {
  const orig = store.files && store.files.resume;
  let spent = 0;
  if (orig && orig.b64) {
    const isDocx = /\.docx$/i.test(orig.name || "") || orig.type === DOCX_TYPE;
    const isPdf = orig.type === "application/pdf" || /\.pdf$/i.test(orig.name || "");
    try {
      const made = isDocx ? await tailorDocx(store, job, orig) : isPdf ? await tailorPdf(store, job, orig) : null;
      if (made && made.file) return made;
      if (made && made.fallthrough_cost) spent = made.fallthrough_cost;
    } catch (e) {
      if (isAccountError(e)) throw e;
      // A file we could not read is not a reason to go without a tailored resume: use the template.
    }
  }
  const made = await tailorFromProfile(store, job);
  return { ...made, cost_usd: (made.cost_usd || 0) + spent };
}
