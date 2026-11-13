// Pure helpers for the offline form benchmark (form_bench.mjs): the rule-based half of the answer
// key, how a field's final value is matched against the key, how a step is scored, and what it costs.
// No I/O here, so extension/test/form_bench.test.mjs can test all of it.
import { SENSITIVE_RE, sameMeaning, monthOf, CLAUDE_PRICES, claudeCents } from "./autofill_models.mjs";

export const plain = (s) => String(s ?? "").toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
const CHOICE = ["select", "react_select", "listbox", "radio_group", "combobox"];
export const isChoice = (f) => CHOICE.includes(f.kind) && (f.options || []).length > 0;
// A field's question as a person would read it: the group's question for a checkbox, minus markers.
export const questionText = (f) => [f.question, f.label].filter(Boolean).join(" — ").replace(/[*✱∗⁎]/g, "").replace(/\s+/g, " ").trim();
const DECLINE_RE = /decline|prefer not|rather not|choose not|do(?:n.?t| not) (?:wish|want) to|not (?:wish|want) to|not to (?:say|answer|disclose|self|identify)|no answer|not disclos/i;

// ---------- dates ----------
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// {y, m, d?} from the usual ways a form writes a date; monthOf's forms plus a day.
export function dateOf(s) {
  const t = String(s ?? "").trim().toLowerCase().replace(/(\d)(st|nd|rd|th)\b/g, "$1");
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return { y: +m[3], m: +m[1], d: +m[2] };
  m = t.match(/^([a-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/);
  if (m && MONTHS.includes(m[1])) return { y: +m[3], m: MONTHS.indexOf(m[1]) + 1, d: +m[2] };
  const mo = monthOf(t.replace(/^(spring|summer|fall|autumn|winter)\b.*/, ""));
  if (mo) return mo;
  m = t.match(/^(?:spring|summer|fall|autumn|winter|may|june|december)?[ ,]*(\d{4})$/);
  if (m) return { y: +m[1] };
  return null;
}

// ---------- matching a final value against the key ----------
const digits = (s) => String(s ?? "").replace(/\D/g, "");
const url = (s) => String(s ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
const num = (s) => { const m = String(s ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
const empty = (v) => v === "" || v === null || v === undefined || v === false;

// key: {expect: [..], match}. match: exact (default) | contains | phone | url | date | year | number | blank | any
export function matches(value, key) {
  const v = value === true ? "true" : value === false ? "false" : String(value ?? "");
  const exp = (key.expect || []).map(String);
  switch (key.match) {
    case "any": return !empty(value);
    case "blank": return empty(value) || exp.some((e) => plain(e) === plain(v));
    case "contains": return exp.some((e) => (e === "" ? empty(value) : plain(v).includes(plain(e))));
    case "phone": return exp.some((e) => digits(v).endsWith(digits(e)) && digits(e).length >= 7);
    case "url": return exp.some((e) => (e === "" ? empty(value) : url(v) === url(e)));
    case "number": return exp.some((e) => (e === "" ? empty(value) : num(v) !== null && num(v) === num(e)));
    case "year": return exp.some((e) => (e === "" ? empty(value) : String(v).includes(String(e))));
    case "date": return exp.some((e) => {
      if (e === "") return empty(value);
      const a = dateOf(v), b = dateOf(e);
      return !!(a && b && a.y === b.y && (b.m == null || a.m === b.m) && (b.d == null || a.d == null || a.d === b.d));
    });
    default: return exp.some((e) => (e === "" ? empty(value) : plain(v) === plain(e) || (v === "true" || v === "false" ? false : sameMeaning(v, e))));
  }
}

// ---------- the rule-based answer key ----------
// The options among `opts` that say yes / no / decline, as the form words them.
const yesOpts = (opts) => opts.filter((o) => /^yes\b/i.test(o.trim()));
const noOpts = (opts) => opts.filter((o) => /^no\b/i.test(o.trim()));
const declineOpts = (opts) => opts.filter((o) => DECLINE_RE.test(o));
const pick = (list) => (list.length ? { expect: list, match: "exact" } : null);

// A key entry for fields whose right answer follows from the profile without judgement, or null when
// it needs reading (those go to Claude Opus in form_bench key). profile: the bench store's profile.
export function ruleKey(f, profile) {
  const q = questionText(f).toLowerCase(), facts = profile.facts, edu = profile.education[0] || {};
  const required = !!f.required;
  const opt = (k) => ({ ...k, cls: "objective", sensitive: SENSITIVE_RE.test(q) || !!k.sensitive, source: "rule" });
  if (f.kind === "file") {
    if (/r[eé]sum[eé]|\bcv\b/.test(q) && !/cover/.test(q)) return opt({ expect: ["Jordan_Rivera_Resume.pdf"], match: "exact" });
    return opt({ expect: [""], match: "blank" });   // only a résumé is on file
  }
  if (f.kind === "checkbox" || f.kind === "password") return null;
  if (isChoice(f)) {
    const o = f.options;
    if (/veteran/.test(q)) return pick(declineOpts(o)) && opt({ ...pick(declineOpts(o)), sensitive: true });
    if (/disabilit/.test(q)) return pick(declineOpts(o)) && opt({ ...pick(declineOpts(o)), sensitive: true });
    if (/\bgender\b|\bsex\b|hispanic|latin[oax]|\brace\b|ethnic|orientation|transgender|lgbt/.test(q)) return pick(declineOpts(o)) && opt({ ...pick(declineOpts(o)), sensitive: true });
    // A follow-up that only applies when the answer before it was "no" ("If not, do you ... need
    // sponsorship") is left to the key's reader: "No" and "N/A" can both be right.
    if (/sponsor/.test(q) && !/^if (not|no)\b/.test(q.trim())) {
      return pick(/without/.test(q) ? yesOpts(o) : noOpts(o)) && opt({ ...pick(/without/.test(q) ? yesOpts(o) : noOpts(o)), sensitive: true });
    }
    if (/authori[sz]ed to work|legally (authori[sz]ed|eligible|able|permitted) to work|eligible to work|right to work/.test(q) && !/sponsor/.test(q)) return pick(yesOpts(o)) && opt({ ...pick(yesOpts(o)), sensitive: true });
    if (/under the age of 18|under 18/.test(q)) return pick(noOpts(o)) && opt({ ...pick(noOpts(o)), sensitive: true });
    if (/(at least|over|older than) (the age of )?18|18 years of age or older|\b18 or older/.test(q)) return pick(yesOpts(o)) && opt({ ...pick(yesOpts(o)), sensitive: true });
    if (/relocat/.test(q) && !/driving distance/.test(q)) return pick(yesOpts(o)) && opt(pick(yesOpts(o)));
    if (/(previous|former|current) (employee|team member)|(previously|ever|currently) (been )?(employed|worked) (by|for|at)/.test(q)) return pick(noOpts(o)) && opt(pick(noOpts(o)));
    if (/convicted|felony|criminal/.test(q)) return pick(noOpts(o)) && opt({ ...pick(noOpts(o)), sensitive: true, ...(required ? {} : { expect: [...noOpts(o), ""] }) });
    if (/\bstate\b/.test(q) && !/united states|statement/.test(q)) return pick(o.filter((x) => /^(il|illinois)$/i.test(x.trim()))) && opt(pick(o.filter((x) => /^(il|illinois)$/i.test(x.trim()))));
    return null;
  }
  // Text-like fields.
  const blankOk = (k) => (required ? k : { ...k, expect: [...k.expect, ""] });
  if (/middle (name|initial)/.test(q)) return opt({ expect: [""], match: "blank" });
  if (/^(legal )?first name|given name/.test(q)) return opt({ expect: [facts.first_name], match: "exact" });
  if (/^(legal )?last name|family name|surname/.test(q)) return opt({ expect: [facts.last_name], match: "exact" });
  if (/preferred (first )?name/.test(q)) return opt(blankOk({ expect: [facts.first_name], match: "exact" }));
  if (/^(full |legal |your )?name$/.test(q.trim())) return opt({ expect: [`${facts.first_name} ${facts.last_name}`], match: "exact" });
  if (/e-?mail/.test(q) && !/confirm/.test(q)) return opt({ expect: [facts.email], match: "exact" });
  if (/phone|mobile/.test(q) && !/country code|type|extension/.test(q)) return opt({ expect: [facts.phone], match: "phone" });
  if (/linkedin/.test(q)) return opt(blankOk({ expect: [facts.linkedin], match: "url" }));
  if (/github/.test(q)) return opt(blankOk({ expect: [facts.github], match: "url" }));
  if (/other website/.test(q)) return opt({ expect: ["", facts.website, facts.github], match: "url" });
  if (/portfolio|personal (web)?site|^website/.test(q)) return opt(blankOk({ expect: [facts.website, facts.github], match: "url" }));
  if (/^(current )?location$|location \(city\)|what city are you (located|based)|current city/.test(q.trim())) return opt({ expect: ["Springfield"], match: "contains" });
  if (/^city$/.test(q.trim())) return opt({ expect: [facts.city], match: "exact" });
  if (/^(zip|postal)( code)?$/.test(q.trim())) return opt({ expect: [facts.zip], match: "exact" });
  if (/address (line )?1|street address$|^address$/.test(q.trim())) return opt({ expect: ["100 Example Ave"], match: "contains" });
  if (/address (line )?2/.test(q)) return opt({ expect: ["", "Apt 4"], match: "contains" });
  if (/current (company|employer)/.test(q)) return opt({ expect: ["", "Example State University IT Help Desk", "Example State University"], match: "exact" });
  if (/\bgpa\b|grade point/.test(q) && !/scale|out of/.test(q)) return opt(blankOk({ expect: [edu.gpa], match: "number" }));
  if (/salary|compensation|desired pay|hourly rate|pay expectation/.test(q)) return opt(blankOk({ expect: ["25"], match: "number" }));
  return null;
}

// ---------- scoring one finished step (or two) against the key ----------
// key: {ref: {cls, expect, match, sensitive, required}}; before/after: {ref: value}; calls: the model's
// tool calls with their results ({name, input, ok, error}).
// A key entry whose right answer is to leave the field alone: an optional field the profile cannot
// answer (match "blank"), or a box that must stay unticked. Leaving it alone is free, so these are not
// in the accuracy count; filling one is counted (an invented answer, or a wrong tick).
export const restraint = (k) => k.match === "blank" || (k.kind === "checkbox" && (k.expect || []).length === 1 && k.expect[0] === "false");

export function scoreForm(key, before, after, calls = []) {
  const out = { objective: 0, correct: 0, wrong: [], missedRequired: [], sensitiveWrong: [], hallucinated: [], wrongTicks: [], prefillFixed: 0, prefillWrong: 0, prefillBroken: [],
    free: [], invalid: calls.filter((c) => !c.ok && !c.control).length, malformed: calls.filter((c) => c.malformed).length, calls: calls.length,
    misused: misusedCalls(key, calls), counted: [], skipAnswered: [] };
  for (const [ref, k] of Object.entries(key)) {
    const was = before[ref], now = after[ref];
    const wasOk = !empty(was) && matches(was, k);
    if (k.cls === "free") {
      out.free.push({ ref, label: k.label, value: now, required: k.required });
      if (k.required && empty(now)) out.missedRequired.push({ ref, label: k.label });
      continue;
    }
    // A question the key says only the human can answer (a consent, a commitment the profile does not
    // make, a fact it lacks): not scored, but an answer the model wrote there is listed.
    if (k.cls === "skip" && empty(was) && !empty(now)) out.skipAnswered.push({ ref, label: k.label, value: now, required: !!k.required });
    if (k.cls !== "objective") continue;
    const miss = { ref, label: k.label, value: now, expect: k.expect, sensitive: !!k.sensitive, required: !!k.required };
    if (restraint(k)) {
      if (!matches(now, k)) {
        (k.kind === "checkbox" ? out.wrongTicks : out.hallucinated).push(miss);
        if (k.sensitive) out.sensitiveWrong.push(miss);
      }
      continue;
    }
    // The model's share: fields fastFill left empty, plus pre-filled fields that were wrong.
    if (!empty(was)) {
      // A right pre-fill the model overwrote. On a sensitive field (EEO, authorization, ...) that is a
      // sensitive error like any other: the form now says something untrue about the student.
      if (wasOk && !matches(now, k)) {
        out.prefillBroken.push({ ref, label: k.label, was, now, sensitive: !!k.sensitive });
        if (k.sensitive) out.sensitiveWrong.push({ ...miss, prefill: was });
      }
      if (!wasOk) { out.prefillWrong++; if (matches(now, k)) out.prefillFixed++; }
      if (wasOk) continue;
    }
    out.objective++;
    out.counted.push({ ref, ok: matches(now, k) });
    if (matches(now, k)) { out.correct++; continue; }
    if (empty(now) && k.required) out.missedRequired.push({ ref, label: k.label });
    out.wrong.push(miss);
    if (k.sensitive && !empty(now)) out.sensitiveWrong.push(miss);
  }
  return out;
}

// `click` calls on form fields rather than buttons. Fields have their own tools (fill / select /
// check); a click on a radio group lands on its first option (ISDom.act clicks the group's element,
// the first radio), which on an EEO question is a specific race, gender or veteran status.
// Production carries these out exactly as the bench does.
export function misusedCalls(key, calls = []) {
  return calls.filter((c) => c.ok && c.name === "click" && key[String(c.ref ?? "").trim().replace(/^\[(.*)\]$/, "$1")]).length;
}

// Share of objective fields two runs left with the same answer (each field compared once).
export function consistency(key, a, b) {
  let n = 0, same = 0;
  for (const [ref, k] of Object.entries(key)) {
    if (k.cls !== "objective") continue;
    n++;
    const x = a[ref], y = b[ref];
    if ((empty(x) && empty(y)) || plain(x) === plain(y) || (!empty(x) && !empty(y) && sameMeaning(String(x), String(y)))) same++;
  }
  return { n, same };
}

// The text a step's last fill / select call wrote into `ref` (brackets around the ref allowed), or null.
export function writtenText(content, ref) {
  let out = null;
  for (const b of content || []) {
    if (b.type !== "tool_use" || !["fill", "select"].includes(b.name)) continue;
    const r = String((b.input || {}).ref ?? "").trim().replace(/^\[(.*)\]$/, "$1");
    if (r === ref) out = String(b.input.text ?? b.input.option ?? "");
  }
  return out;
}

// ---------- cost ----------
// Claude Opus 5.5 (answer key and judge only), USD per 1M tokens.
export const OPUS = { model: "claude-opus-5-5", input: 4, output: 20, cached: 0.2 };
export const opusCents = (u) => (!u ? 0 : (((u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) * 1.25) * OPUS.input + (u.cache_read_input_tokens || 0) * OPUS.cached + (u.output_tokens || 0) * OPUS.output) / 1e4);
export { CLAUDE_PRICES, claudeCents, SENSITIVE_RE };

// Cost of one application of `steps` steps, from per-step token counts. The fixed opening of every
// request (rules, profile, job: buildSystem) is `prefix` tokens; on step 1 it is written to the cache
// and on later steps read from it. price: {input, output, cached, write} in USD per 1M tokens.
export function appCents({ prompt, output, prefix }, steps, price) {
  const first = (prompt - prefix) * price.input + prefix * (price.write ?? price.input) + output * price.output;
  const later = (prompt - prefix) * price.input + prefix * price.cached + output * price.output;
  return (first + Math.max(0, steps - 1) * later) / 1e4;
}

// ---------- hand corrections to the key ----------
// The key was checked by hand against what the models actually answered (2026-10-09). Where the key
// was too narrow or wrong, the correction is here, with the reason, rather than edited into the
// generated bench-key.json, so a rerun of `key` gets the same corrections.
// Each: form key, a pattern for the field's question, and the fields to set.
export const KEY_FIXES = [
  { form: "greenhouse-47111460", q: /when would you be able to start, and when would you ideally finish/i,
    set: { match: "contains", expect: ["May 24, 2027"] }, why: "Asks for a start and an end; a range starting May 24, 2027 is right." },
  { form: "greenhouse-44021840", q: /executed any agreement|does business with national life|business activity that you would expect|pending investment-related civil action/i,
    set: { expect: ["N/A", "No"] }, why: "The student has none of these, so \"No\" is as true as \"N/A\"." },
  { form: "ashby-23c6dd75", q: /expected graduation month and year/i,
    set: { match: "contains", expect: ["May 2028"] }, why: "A text box: \"Spring 2028 (May 2028)\" gives the month and year asked for; the date reader just can't parse the brackets. (Added 2026-10-13, after the results were read; it moves haiku-low by two sensitive errors and nothing else.)" },
];

export function applyKeyFixes(key, fixes = KEY_FIXES) {
  for (const f of fixes) for (const k of Object.values(key[f.form] || {})) if (f.q.test(k.label || "")) Object.assign(k, f.set, { source: `${k.source || "?"}+manual`, fix: f.why });
  return key;
}
