// One AI call per job: reword the candidate's existing resume content toward the posting, check it,
// and hand back a file that looks like the resume the student uploaded.
//
// Three ways to build that file, tried in this order. (was: "Each one falls through to the next on
// any problem that is about the file". The review showed what that meant: a student with a Word or
// PDF resume whose format could not be kept was handed the fixed template instead, and with
// "use automatically" on it was sent to the employer without anyone having seen it. Now, when 1 or 2
// cannot keep the format, automatic mode uses the student's own file untouched, and review mode
// still offers the template but says plainly that it is not their layout. See tailorResume.)
// A cap or a sign-in error always stops here, since trying again would only hit it again.
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
// was: import { renderLayoutFit } from "../lib/pdf_layout.js";
import { lossless, renderLayoutFit, sameLink, siteOf, urisIn } from "../lib/pdf_layout.js";
// was: import { applyDocTailoring, docTailorInput, layoutMatchesProfile, normalizeLayout } from "../lib/resume_doc.js";
import { applyDocTailoring, docTailorInput, docText, layoutMatchesProfile, layoutRefusal, normalizeLayout } from "../lib/resume_doc.js";
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
A bullet may list "keep": words that are bold, italic, a link, or set after a tab in the file. Keep each of them exactly as written and in the same place in the bullet, and reword only around them; a rewording that changes them is thrown away.
${RULES}

Reply with JSON only, listing only the groups you changed:
{"groups": [{"g": <group>, "bullets": [{"from": <original bullet index j>, "text": "..."}]}],
 "changes": ["short note on each meaningful change and why it fits the posting"]}
When you list a group's bullets, list every bullet you are keeping, in the new order.`;

const SYSTEM_LAYOUT = `You transcribe a resume PDF into JSON so it can be redrawn looking the same. Copy every word exactly as printed: never fix, shorten, reorder or leave out anything, and never add anything. Mark bold text as **bold** and italic text as *italic*.

{"columns": <how many side-by-side columns of body text the page has: 1 for an ordinary resume (dates set against the right margin do not count), 2 or more for a sidebar or a two-column design>,
 "graphics": true|false,                // true if the page has a photo, icons, logos, skill bars, shaded boxes or a coloured sidebar
 "style": {
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
// BUILD names the code that turns a reply into a file. It is part of the cache key, so a file built
// by an older, faultier version of lib/docx.js or lib/pdf_layout.js is not handed out again.
const BUILD = "format-2";
// was: tailorWith(store, job, system, prompt, build, extra) and tailorKey(model, system, prompt).
// The key was made of words only. Two Word files with the same bullets but a different font, or the
// same PDF re-read into a different layout, shared one key, and the student who uploaded a new file
// was handed the tailored copy of the old one. `salt` carries what the file is (see the callers); it
// goes into the key and not into the prompt.
async function tailorWith(store, job, system, prompt, build, extra, salt = "") {
  const model = modelFor(store, "tailor");
  const key = await tailorKey(model, system, `${prompt}\n${BUILD}\n${salt}`);
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
    ...(made.note ? { note: made.note } : {}),
  };
  await writeTailored(key, tailored);
  return { ...tailored, cost_usd: resp.cost_usd || 0 };
}

// ---------- 1. Word original, edited in place ----------
async function tailorDocx(store, job, orig) {
  const opened = await openDocx(orig.b64);
  const parsed = bulletGroups(opened.xml);
  // was: ... < 3) return null;
  if (parsed.groups.reduce((n, g) => n + g.items.length, 0) < 3) return { why: "it has fewer than three bullets that could be read" }; // not a bulleted resume we can read
  const prompt = `${jobText(job)}\n\nCANDIDATE\n${voiceOf(store)}\n\nRESUME BULLET GROUPS (JSON)\n${JSON.stringify(docxTailorInput(parsed))}`;
  return tailorWith(store, job, SYSTEM_DOCX, prompt, async (out) => {
    const { xml, diff } = applyDocxTailoring(opened.xml, parsed, out);
    const bytes = await saveDocx(opened, xml);
    return { bytes, diff, name: `${baseName(store)}_Resume.docx`, type: DOCX_TYPE };
  }, { format: "docx", note: "This is your own Word file with only the bullets below changed. Open it to check it still fits the page." }, await fingerprint(orig));
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
//
// Three things the review found in the first version, all from remembering the verdict and not the
// reading. The check against the profile ran before saving, so a student who uploaded the resume
// first and filled in the profile second was remembered as "not their resume" for good; it runs on
// every use now, on the saved reading. A reply that was cut short or was not JSON was remembered
// for good as well; with no reason attached it is now tried again after an hour. A refusal with a
// reason (columns, graphics) is a fact about the file and is kept.
const LAYOUT_RETRY_MS = 60 * 60 * 1000;
async function layoutOf(store, job, orig) {
  const fp = await fingerprint(orig);
  let saved = null;
  try { saved = (await chrome.storage.local.get(LAYOUT_KEY))[LAYOUT_KEY]; } catch { /* read it again below */ }
  // was: if (saved && saved.fp === fp) return { doc: saved.doc, cost_usd: 0 };
  if (saved && saved.fp === fp && (saved.doc || saved.why || Date.now() - (saved.created || 0) < LAYOUT_RETRY_MS)) {
    if (saved.doc && !layoutMatchesProfile(saved.doc, store)) return { doc: null, why: MISMATCH, cost_usd: 0 };
    return { doc: saved.doc, why: saved.why || (saved.doc ? "" : UNREAD), cost_usd: 0 };
  }
  const resp = await callAI({
    ai: store.ai, model: modelFor(store, "tailor"), kind: "tailor", run_id: job.run_id, max_tokens: 6000, system: SYSTEM_LAYOUT,
    messages: [{ role: "user", content: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: orig.b64 }, title: "Resume" },
      { type: "text", text: "Transcribe this resume into the JSON described. JSON only." },
    ] }],
  });
  let doc = null, why = "";
  // was: try { doc = normalizeLayout(jsonOf(resp)); } catch { doc = null; }
  try { const raw = jsonOf(resp); why = layoutRefusal(raw); doc = normalizeLayout(raw); } catch { doc = null; }
  // was: if (doc && !layoutMatchesProfile(doc, store)) doc = null;   (before saving; see above)
  try { await chrome.storage.local.set({ [LAYOUT_KEY]: { fp, doc, why, created: Date.now() } }); } catch { /* costs a call next time, nothing else */ }
  if (doc && !layoutMatchesProfile(doc, store)) return { doc: null, why: MISMATCH, cost_usd: resp.cost_usd || 0 };
  return { doc, why: why || (doc ? "" : UNREAD), cost_usd: resp.cost_usd || 0 };
}
const MISMATCH = "what was read from it does not match the name, employers and schools in your profile";
const UNREAD = "its layout could not be read";

const PDF_NOTE = "Rebuilt to match your PDF's layout. Preview it and check names and dates before using it.";
async function tailorPdf(store, job, orig) {
  // was: if (orig.b64.length > MAX_PDF_B64) return null;
  if (orig.b64.length > MAX_PDF_B64) return { why: "the file is too large to read" };
  const { doc: read, why, cost_usd } = await layoutOf(store, job, orig);
  // was: if (!doc) return cost_usd ? { fallthrough_cost: cost_usd } : null;
  if (!read) return { fallthrough_cost: cost_usd, why };
  // The eight built-in PDF fonts draw Western European text only. A name or a word in any other
  // script used to come out changed or missing, silently (see lossless in lib/pdf_layout.js).
  if (!lossless(docText(read))) return { fallthrough_cost: cost_usd, why: "it uses letters the PDF builder cannot draw; upload a Word version of it and those are kept" };
  const doc = { ...read, links: urisIn(orig.b64) };
  const prompt = `${jobText(job)}\n\nCANDIDATE\n${voiceOf(store)}\n\nRESUME (JSON)\n${JSON.stringify(docTailorInput(doc))}`;
  const made = await tailorWith(store, job, SYSTEM_DOC, prompt, async (out) => {
    const applied = applyDocTailoring(doc, out);
    const { bytes, linked } = renderLayoutFit(applied.doc);
    const lost = doc.links.filter((u) => !linked.some((l) => sameLink(l, u)));
    const note = lost.length ? `${PDF_NOTE} ${lost.length === 1 ? "One link" : `${lost.length} links`} from your PDF could not be carried over (${[...new Set(lost.map((u) => siteOf(u) || "email"))].join(", ")}): the words are there but are not clickable.` : "";
    return { bytes, diff: applied.diff, note, name: `${baseName(store)}_Resume.pdf`, type: "application/pdf" };
  }, { format: "pdf_layout", note: PDF_NOTE }, `${await fingerprint(orig)}\n${JSON.stringify(doc)}`);
  return made ? { ...made, cost_usd: (made.cost_usd || 0) + cost_usd } : { fallthrough_cost: cost_usd, why: "the reply could not be used" };
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
  let spent = 0, why = "", keeps = false;
  if (orig && orig.b64) {
    const isDocx = /\.docx$/i.test(orig.name || "") || orig.type === DOCX_TYPE;
    const isPdf = orig.type === "application/pdf" || /\.pdf$/i.test(orig.name || "");
    keeps = isDocx || isPdf;
    try {
      const made = isDocx ? await tailorDocx(store, job, orig) : isPdf ? await tailorPdf(store, job, orig) : null;
      if (made && made.file) return made;
      if (made && made.fallthrough_cost) spent = made.fallthrough_cost;
      why = (made && made.why) || (made === null ? "the reply could not be used" : "");
    } catch (e) {
      if (isAccountError(e)) throw e;
      // A file we could not read is not a reason to go without a tailored resume: use the template.
      // (Still true in review mode. In automatic mode, see below.)
      why = "the file could not be read";
      if (e && e.cost_usd) spent += Number(e.cost_usd) || 0;
    }
  }
  // The student has a Word or PDF resume and its format could not be kept. With "use automatically"
  // on, nobody looks before it is uploaded, and a resume in our template is not the one they chose
  // to send: their own file goes, untouched, and the template call is not made (or paid for).
  if (keeps && store.settings && store.settings.tailor_resume === "auto") {
    const e = new Error(`your resume's own format could not be kept: ${why || "the file could not be read"}`);
    e.cost_usd = spent;
    throw e;
  }
  const made = await tailorFromProfile(store, job);
  // was: return { ...made, cost_usd: (made.cost_usd || 0) + spent };
  const note = keeps ? `We could not keep your own file's format for this one (${why || "the file could not be read"}). This version uses InternScout's standard layout, not yours, and is built from your profile. Use it only if you are happy with how it looks.` : "";
  return { ...made, format: "template", ...(note ? { note } : {}), cost_usd: (made.cost_usd || 0) + spent };
}
