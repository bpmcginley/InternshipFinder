// Real application forms for the offline benchmark (form_bench.mjs): which postings, how their
// questions are read from the public job-board APIs, and how each is drawn back into an HTML form
// that looks like the applicant-tracking system's own, for the extension's snapshot code to read.
//
// Read-only throughout. Greenhouse and Lever are plain GETs (boards-api.greenhouse.io with
// ?questions=true; the Lever apply page, whose <form> is server-rendered). Ashby serves its form only
// through the read-only GraphQL query its own job page makes (jobs.ashbyhq.com/api/non-user-graphql,
// op ApiJobPosting). Nothing is ever submitted: the rendered forms live in memory and in headless
// Chrome with every outside request blocked.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const UA = "InternScout-eval/1.0 (offline form benchmark; read-only)";
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const stripTags = (h) => String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|li|div|h\d)>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

// Which ATS an apply URL belongs to, and the board token and posting id in it. Only the ATS-hosted
// URLs: a company's own careers page with ?gh_jid= does not name the board token.
export function parseAts(url) {
  const u = String(url || "");
  let m = u.match(/^https:\/\/(?:boards|job-boards)\.greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/);
  if (m) return { ats: "greenhouse", token: m[1], id: m[2] };
  m = u.match(/^https:\/\/jobs\.(eu\.)?lever\.co\/([^/?#]+)\/([0-9a-f-]{36})/);
  if (m) return { ats: "lever", token: m[2], id: m[3], eu: !!m[1] };
  m = u.match(/^https:\/\/jobs\.ashbyhq\.com\/([^/?#]+)\/([0-9a-f-]{36})/);
  if (m) return { ats: "ashby", token: decodeURIComponent(m[1]), id: m[2] };
  return null;
}

// The four kinds of internship the benchmark covers, from the listing's field tags.
export function categoryOf(tags = []) {
  const t = new Set(tags);
  if (t.has("marketing") || t.has("communications")) return "marketing";
  if (t.has("finance") || t.has("quant") || t.has("accounting") || t.has("economics")) return "finance";
  if (t.has("data") || t.has("ml")) return "data";
  if (t.has("swe")) return "swe";
  return null;
}

// Open US Greenhouse / Lever / Ashby internships from the site's own data (docs/data/listings).
export function listingCandidates(root) {
  const dir = join(root, "docs/data/listings");
  const byId = new Map(), desc = {};
  for (const f of readdirSync(dir)) {
    const path = join(dir, f);
    if (f.endsWith(".desc.json")) { Object.assign(desc, JSON.parse(readFileSync(path, "utf8"))); continue; }
    if (!f.endsWith(".json")) continue;
    const rows = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(rows)) continue;
    for (const j of rows) {
      if (!j || typeof j !== "object" || j.status !== "open") continue;
      const a = parseAts(j.apply_url);
      if (!a || a.ats !== j.ats) continue;
      if (!(j.regions || []).some((r) => r.kind === "us")) continue;
      const cat = categoryOf(j.field_tags);
      if (!cat) continue;
      byId.set(j.id, { ...a, cat, listing: j });
    }
  }
  return [...byId.values()].map((c) => ({ ...c, description: desc[c.listing.id] || "" }))
    .sort((a, b) => (a.listing.id < b.listing.id ? -1 : 1));
}

async function getJson(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { "user-agent": UA, ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const ASHBY_QUERY = `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
  jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
    id title
    applicationForm { id sections { title descriptionHtml fieldEntries { ... on FormFieldEntry { id field descriptionHtml isRequired isHidden } } } }
    surveyForms { id sections { title descriptionHtml fieldEntries { ... on FormFieldEntry { id field descriptionHtml isRequired isHidden } } } }
  } }`;

// The posting's application form as the ATS describes it.
export async function fetchSource(c) {
  if (c.ats === "greenhouse") return getJson(`https://boards-api.greenhouse.io/v1/boards/${c.token}/jobs/${c.id}?questions=true`);
  if (c.ats === "lever") {
    const res = await fetch(`https://jobs.${c.eu ? "eu." : ""}lever.co/${c.token}/${c.id}/apply`, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`${res.status} lever ${c.token}/${c.id}`);
    const html = await res.text();
    const a = html.indexOf("<form"), b = html.indexOf("</form>", a);
    if (a < 0 || b < 0) throw new Error("no form on the Lever page");
    return { form: html.slice(a, b + 7) };
  }
  const d = await getJson("https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ operationName: "ApiJobPosting", variables: { organizationHostedJobsPageName: c.token, jobPostingId: c.id }, query: ASHBY_QUERY }) });
  if (!d.data || !d.data.jobPosting || !d.data.jobPosting.applicationForm) throw new Error("ashby: no application form");
  return d.data.jobPosting;
}

// ---------- questions in a common shape, for picking forms and for the answer key ----------
// [{label, type: text|textarea|select|multi|file|bool, required, options[]}]
export function questionsOf(ats, src) {
  const out = [];
  if (ats === "greenhouse") {
    for (const q of [...(src.questions || []), ...(src.location_questions || [])]) {
      const f = (q.fields || [])[0] || {};
      out.push({ label: q.label, required: !!q.required, type: ghType(f.type), options: (f.values || []).map((v) => v.label), name: f.name });
    }
    for (const sec of src.compliance || []) for (const q of sec.questions || []) {
      const f = (q.fields || [])[0] || {};
      out.push({ label: q.label, required: !!q.required, type: "select", options: (f.values || []).map((v) => v.label), eeo: true });
    }
    for (const q of (src.demographic_questions && src.demographic_questions.questions) || []) {
      out.push({ label: q.label, required: !!q.required, type: /multi/.test(q.type) ? "multi" : "select", options: (q.answer_options || []).map((o) => o.label), eeo: true });
    }
  } else if (ats === "ashby") {
    const forms = [src.applicationForm, ...(src.surveyForms || [])];
    forms.forEach((form, fi) => {
      for (const s of form.sections || []) for (const e of s.fieldEntries || []) {
        if (!e || !e.field || e.isHidden) continue;
        out.push({ label: e.field.title, required: !!e.isRequired, type: ashbyType(e.field.type), options: (e.field.selectableValues || []).map((v) => v.label), eeo: fi > 0 });
      }
    });
  } else {
    // Lever: the custom cards carry their questions as JSON in a hidden input; the fixed fields are known.
    for (const m of src.form.matchAll(/<input type="hidden" value="([^"]*)" name="cards\[[^\]]+\]\[baseTemplate\]"/g)) {
      try {
        const card = JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
        for (const f of card.fields || []) out.push({ label: f.text, required: !!f.required, type: leverType(f.type), options: (f.options || []).map((o) => o.text) });
      } catch (e) { /* a card we cannot read is left out of the count only */ }
    }
  }
  return out;
}
const ghType = (t) => ({ input_text: "text", textarea: "textarea", input_file: "file", multi_value_single_select: "select", multi_value_multi_select: "multi", input_hidden: "hidden" })[t] || "text";
const ashbyType = (t) => ({ String: "text", Email: "text", Phone: "text", Location: "text", LongText: "textarea", File: "file", Boolean: "bool", ValueSelect: "select", MultiValueSelect: "multi", Date: "text", Number: "text", SocialLink: "text" })[t] || "text";
const leverType = (t) => ({ text: "text", textarea: "textarea", "multiple-choice": "select", "multiple-select": "multi", dropdown: "select", university: "select", file: "file" })[t] || "text";

const STANDARD_RE = /^(first name|last name|preferred (first )?name|full name|name|email|phone|phone number|resume|resume\/cv|cover letter|linkedin|linkedin profile|website|location \(city\)|location|current location|current company|github)\b/i;
export const customQuestions = (qs) => qs.filter((q) => !q.eeo && q.type !== "hidden" && !STANDARD_RE.test(String(q.label).trim()));
export const freeTextQuestions = (qs) => customQuestions(qs).filter((q) => q.type === "textarea");

// ---------- rendering ----------
const page = (job, body, extraHead = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(job.title)} at ${esc(job.company)}</title>
<style>body{font-family:sans-serif;max-width:760px;margin:20px auto}input,select,textarea{display:block;width:100%;min-height:24px;margin:4px 0 14px}input[type=radio],input[type=checkbox]{display:inline-block;width:auto}textarea{min-height:80px}</style>${extraHead}</head>
<body>${body}</body></html>`;

function ghQuestion(q, n) {
  const f = (q.fields || [])[0] || {};
  const id = String(f.name || `q${n}`).replace(/\[\]$/, "");
  const star = q.required ? '<span class="required" aria-hidden="true">*</span>' : "";
  const req = q.required ? ' aria-required="true"' : "";
  const desc = q.description ? `<div class="description" id="${esc(id)}-description">${esc(stripTags(q.description))}</div>` : "";
  const type = f.type;
  if (type === "input_hidden") return "";
  if (type === "input_file") {
    return `<div class="file-upload" role="group" aria-labelledby="upload-label-${esc(id)}"><div id="upload-label-${esc(id)}" class="label upload-label">${esc(q.label)}${star}</div>${desc}
<div class="file-upload__wrapper"><button type="button" class="btn btn--pill">Attach</button><button type="button" class="btn btn--pill">Enter manually</button>
<input id="${esc(id)}" type="file" class="visually-hidden" accept=".pdf,.doc,.docx,.txt,.rtf"${req}></div><p class="file-types">Accepted file types: pdf, doc, docx, txt, rtf</p></div>`;
  }
  if (type === "textarea") return `<div class="field-wrapper"><label for="${esc(id)}" id="${esc(id)}-label">${esc(q.label)}${star}</label>${desc}<textarea id="${esc(id)}"${req}></textarea></div>`;
  if (type === "multi_value_single_select") {
    return `<div class="field-wrapper select"><label for="${esc(id)}" id="${esc(id)}-label">${esc(q.label)}${star}</label>${desc}<select id="${esc(id)}"${req}><option value="">Select...</option>${(f.values || []).map((v) => `<option value="${esc(v.value)}">${esc(v.label)}</option>`).join("")}</select></div>`;
  }
  if (type === "multi_value_multi_select") {
    return `<fieldset class="checkbox"><legend id="${esc(id)}-label">${esc(q.label)}${star}</legend>${desc}${(f.values || []).map((v, i) =>
      `<div class="checkbox__wrapper"><input type="checkbox" id="${esc(id)}_${i}" name="${esc(id)}[]" value="${esc(v.value)}"><label for="${esc(id)}_${i}">${esc(v.label)}</label></div>`).join("")}</fieldset>`;
  }
  return `<div class="field-wrapper"><label for="${esc(id)}" id="${esc(id)}-label">${esc(q.label)}${star}</label>${desc}<input id="${esc(id)}" type="text"${req}></div>`;
}

export function renderGreenhouse(job, src) {
  const parts = [`<div class="job__header"><h1 class="section-header">${esc(src.title || job.title)}</h1><div class="job__location">${esc(job.location)}</div></div>`,
    `<form id="application-form" class="application--form"><div class="application--header"><h2 class="section-header">Apply for this job</h2><span class="required">* indicates a required field</span></div>`];
  [...(src.questions || []), ...(src.location_questions || [])].forEach((q, i) => parts.push(ghQuestion(q, i)));
  for (const sec of src.compliance || []) {
    parts.push(`<div class="eeoc__container"><h3>U.S. Equal Employment Opportunity Information</h3><p>${esc(stripTags(sec.description || "")).slice(0, 600)}</p>`);
    for (const q of sec.questions || []) parts.push(ghQuestion(q, q.label));
    parts.push("</div>");
  }
  const dq = src.demographic_questions;
  if (dq && dq.questions && dq.questions.length) {
    parts.push(`<div class="demographic-questions"><h3>${esc(dq.header || "Voluntary Self-Identification")}</h3>`);
    for (const q of dq.questions) {
      const multi = /multi/.test(q.type);
      parts.push(ghQuestion({ label: q.label, required: q.required, fields: [{ name: `demographic_${q.id}`, type: multi ? "multi_value_multi_select" : "multi_value_single_select",
        values: (q.answer_options || []).map((o) => ({ label: o.label, value: o.id })) }] }, q.id));
    }
    parts.push("</div>");
  }
  parts.push(`<button type="submit" class="btn btn--pill">Submit application</button></form>`);
  return page(job, parts.join("\n"));
}

// Lever's own form markup, with its scripts, frames and pictures taken out. The few pieces Lever's
// stylesheet hides until something happens (upload progress, the LinkedIn button's other states, the
// location dropdown) are hidden the same way here so they don't read as page text.
export function renderLever(job, src) {
  const form = src.form.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<(iframe|noscript|style|svg)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(img|link)\b[^>]*>/gi, "");
  const css = `<style>.awli-button .loading,.awli-button .completed,.resume-upload-failure,.resume-upload-working,.resume-upload-success,.resume-upload-oversize,.dropdown-container,.iframe-mask,.application-error{display:none}</style>`;
  const head = `<div class="posting-headline"><h2>${esc(job.title)}</h2><div class="posting-categories"><div class="location">${esc(job.location)}</div></div></div>`;
  return page(job, `<div class="main-header"><a class="main-header-logo" href="#">${esc(job.company)}</a></div>${head}${form}`, css);
}

function ashbyEntry(e, n) {
  const f = e.field || {};
  const id = `ashby_${String(f.path || n).replace(/[^\w-]/g, "_")}`;
  const reqClass = e.isRequired ? " _required_1x6pz_99" : "";
  const req = e.isRequired ? " required" : "";
  const desc = e.descriptionHtml ? `<div class="ashby-application-form-question-description">${esc(stripTags(e.descriptionHtml))}</div>` : "";
  const title = `<label for="${esc(id)}" class="ashby-application-form-question-title _heading_101oc_53${reqClass}">${esc(f.title)}</label>`;
  const opts = f.selectableValues || [];
  switch (f.type) {
    case "LongText": return `<div class="ashby-application-form-field-entry">${title}${desc}<textarea id="${esc(id)}" name="${esc(id)}"${req}></textarea></div>`;
    case "File": return `<div class="ashby-application-form-field-entry">${title}${desc}<div class="_container_ upload"><button type="button">Upload File</button><input type="file" id="${esc(id)}" name="${esc(id)}"${req}></div></div>`;
    case "Boolean":
      return `<fieldset class="ashby-application-form-field-entry" id="${esc(id)}">${title.replace(/for="[^"]*"/, `for="${esc(id)}"`)}${desc}` +
        ["Yes", "No"].map((o, i) => `<span><input type="radio" id="${esc(id)}_${i}" name="${esc(id)}" value="${o}"${req}><label for="${esc(id)}_${i}">${o}</label></span>`).join("") + "</fieldset>";
    case "ValueSelect":
      return `<fieldset class="ashby-application-form-field-entry" id="${esc(id)}">${title}${desc}` +
        opts.map((o, i) => `<span><input type="radio" id="${esc(id)}_${i}" name="${esc(id)}" value="${esc(o.value)}"${req}><label for="${esc(id)}_${i}">${esc(o.label)}</label></span>`).join("") + "</fieldset>";
    case "MultiValueSelect":
      return `<fieldset class="ashby-application-form-field-entry" id="${esc(id)}">${title}${desc}` +
        opts.map((o, i) => `<span><input type="checkbox" id="${esc(id)}_${i}" name="${esc(id)}" value="${esc(o.value)}"><label for="${esc(id)}_${i}">${esc(o.label)}</label></span>`).join("") + "</fieldset>";
    default: {
      const type = { Email: "email", Phone: "tel", Date: "date", Number: "number" }[f.type] || "text";
      return `<div class="ashby-application-form-field-entry">${title}${desc}<input type="${type}" id="${esc(id)}" name="${esc(id)}"${req}></div>`;
    }
  }
}

export function renderAshby(job, src) {
  const parts = [`<h1 class="ashby-job-posting-heading">${esc(src.title || job.title)}</h1>`, `<form class="ashby-application-form-container">`];
  let n = 0;
  for (const s of src.applicationForm.sections || []) {
    if (s.title && s.title !== "Details") parts.push(`<h2 class="ashby-application-form-section-header">${esc(s.title)}</h2>`);
    for (const e of s.fieldEntries || []) if (e && e.field && !e.isHidden) parts.push(ashbyEntry(e, n++));
  }
  for (const sf of src.surveyForms || []) {
    parts.push(`<div class="ashby-survey-form"><h2>${esc(sf.title || "U.S. Equal Employment Opportunity Information")}</h2>`);
    for (const s of sf.sections || []) for (const e of s.fieldEntries || []) if (e && e.field && !e.isHidden) parts.push(ashbyEntry(e, n++));
    parts.push("</div>");
  }
  parts.push(`<button type="submit" class="ashby-application-form-submit-button">Submit Application</button></form>`);
  return page(job, parts.join("\n"));
}

export const renderForm = (ats, job, src) => (ats === "greenhouse" ? renderGreenhouse : ats === "lever" ? renderLever : renderAshby)(job, src);

// The job as the extension's queue holds it (agent.js jobIntro reads company, title, location,
// apply_url, description), from the listing the site published.
export function jobOf(c) {
  const l = c.listing;
  // docs/js/app.js autoApply builds the payload this way, and background/queue.js keeps 6,000 characters.
  const location = (l.region_locations || []).join("; ") || l.location_raw || (l.regions || []).map((r) => r.loc).join("; ");
  return { id: l.id, company: l.company_name, title: l.title, location, apply_url: l.apply_url, description: String(c.description || "").slice(0, 6000) };
}

export { stripTags, esc };
