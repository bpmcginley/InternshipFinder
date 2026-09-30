// Is Flash-Lite good enough for Auto-Apply? Replays recorded Auto-Apply steps against other models and
// scores how often they would have done what production's model did. See scripts/eval/README.md.
//
//   GEMINI_API_KEY=... node scripts/eval/autofill_models.mjs steps.json [--models=gemini-3.5-flash-lite,gemini-3.8-flash] [--limit=N]
//
// steps.json comes from the extension (ISEval.export(), background/evalrec.js). Each request is built
// the way production builds it: the extension's buildGeminiBody, then the Worker's own sanitizeRequest
// for the autofill task (token and thinking ceilings), with only the model swapped. Listing the
// production model too (the default) measures how often it disagrees with ITSELF on a second try, which
// is the fair bar for any cheaper model: a model can only be asked to match that.
//
// --thinking=low|medium|high sets every model's thinking level instead of production's ceiling for the
// task (low for autofill). Steps recorded with a student's own Gemini key ran at "medium", so replaying
// those at production's level makes the production model look less consistent than it is.
//
// Writes eval-report.md and eval-results.json beside steps.json. Nothing is sent anywhere else.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

globalThis.chrome = globalThis.chrome || { runtime: {}, storage: { local: {}, session: {} }, tabs: {}, scripting: {} };
const { buildGeminiBody } = await import("../../extension/background/gemini.js");
const { TOOLS } = await import("../../extension/background/agent.js");
const { CONFIG, FLASH_LITE } = await import("../../worker/src/config.js");
const { sanitizeRequest, costCents } = await import("../../worker/src/gemini.js");

// Questions where a wrong answer does real harm; any disagreement here is listed first in the report.
export const SENSITIVE_RE = /authori[sz]|sponsor|visa|citizen|veteran|disabilit|gender|race|ethnic|hispanic|criminal|convict|background check|salary|compensation|\b18\b|\bage\b|clearance|relocat|start date|graduat|gpa/i;
const FREE_TEXT_MIN = 60;          // a fill longer than this is prose, judged by a person, not by equality

const plain = (s) => String(s ?? "").toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();

// ref -> label, from the step's latest SNAPSHOT: lines like  [f12] select *"Veteran status" = "" ...
export function labelsOf(messages) {
  const labels = {};
  const last = [...messages].reverse().find((m) => m.role === "user" && Array.isArray(m.content)
    && m.content.some((b) => b.type === "text" && b.text.startsWith("SNAPSHOT") && !b.text.includes("older page state removed")));
  const text = last ? last.content.filter((b) => b.type === "text" && b.text.startsWith("SNAPSHOT")).map((b) => b.text).join("\n") : "";
  for (const m of text.matchAll(/\[([A-Za-z0-9_:.-]+)\][^"\n]*"([^"\n]*)"/g)) if (!(m[1] in labels)) labels[m[1]] = m[2];
  return labels;
}

// What a step decided, as comparable pieces: one per field touched, plus where it went next.
export function decisions(content) {
  const fields = {}, moves = [];
  for (const b of content || []) {
    if (b.type !== "tool_use") continue;
    const i = b.input || {};
    if (["fill", "select", "check", "upload", "fill_secret"].includes(b.name) && i.ref) {
      const value = b.name === "check" ? String(!!i.checked) : b.name === "upload" ? i.file : b.name === "fill_secret" ? "(password)" : (i.text ?? i.option ?? "");
      fields[i.ref] = { tool: b.name, value: String(value) };
    } else if (b.name === "click") moves.push(`click ${i.ref}`);
    else if (b.name !== "wait") moves.push(b.name);
  }
  return { fields, moves };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

// {y, m} from the ways a form's date is written: 05/01/2028, 5/2028, 2028-05-31, May 2028, 05/2028.
export function monthOf(s) {
  const t = String(s ?? "").trim().toLowerCase();
  let m = t.match(/^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/);
  if (m) return { y: +m[1], m: +m[2] };
  m = t.match(/^(\d{1,2})\/(?:\d{1,2}\/)?(\d{4})$/);
  if (m) return { y: +m[2], m: +m[1] };
  m = t.match(/^([a-z]{3})[a-z]*\.?,? (\d{4})$/);
  if (m && MONTHS.includes(m[1])) return { y: +m[2], m: MONTHS.indexOf(m[1]) + 1 };
  return null;
}

// The same answer written differently: one date in two formats, one amount with or without a word
// around it ("$33/hour" and "$33/hour base"), or one answer that contains the other ("Negotiable" and
// "Competitive / Negotiable"). These are counted as agreeing and listed on their own for a glance,
// instead of among the sensitive disagreements, where in the first run they were all of them.
export function sameMeaning(a, b) {
  const da = monthOf(a), db = monthOf(b);
  if (da && db) return da.y === db.y && da.m === db.m;
  const nums = (s) => (String(s).match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(",", "")).sort().join("|");
  const pa = plain(a), pb = plain(b);
  if (nums(a) && nums(a) === nums(b) && (pa.includes(pb) || pb.includes(pa))) return true;
  if (!nums(a) && !nums(b) && pa && pb && (pa.includes(pb) || pb.includes(pa)) && Math.min(pa.length, pb.length) >= 4) return true;
  return false;
}

// How a candidate step compares with the recorded one.
export function compare(base, cand, labels = {}) {
  const refs = new Set([...Object.keys(base.fields), ...Object.keys(cand.fields)]);
  const out = { same: 0, differ: [], missed: [], extra: [], prose: [], reworded: [] };
  for (const ref of refs) {
    const a = base.fields[ref], b = cand.fields[ref];
    const label = labels[ref] || ref;
    if (a && !b) { out.missed.push({ ref, label, base: a.value }); continue; }
    if (b && !a) { out.extra.push({ ref, label, cand: b.value }); continue; }
    if (a.value.length > FREE_TEXT_MIN || b.value.length > FREE_TEXT_MIN) { out.prose.push({ ref, label, base: a.value, cand: b.value }); out.same++; continue; }
    if (plain(a.value) === plain(b.value)) out.same++;
    else if (sameMeaning(a.value, b.value)) { out.same++; out.reworded.push({ ref, label, base: a.value, cand: b.value }); }
    else out.differ.push({ ref, label, base: a.value, cand: b.value, sensitive: SENSITIVE_RE.test(label) });
  }
  out.movesAgree = base.moves.join("|") === cand.moves.join("|");
  out.decided = refs.size;
  return out;
}

async function ask(model, step, key, thinking) {
  const config = { ...CONFIG, TASKS: { ...CONFIG.TASKS, autofill: { ...CONFIG.TASKS.autofill, model } } };
  const body = sanitizeRequest(buildGeminiBody({ system: step.system, messages: step.messages, tools: TOOLS, max_tokens: 8000 }), "autofill", config);
  if (thinking) body.generationConfig.thinkingConfig = { thinkingLevel: thinking };
  const t0 = Date.now();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${(data.error && data.error.message) || ""}`);
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  const content = parts.filter((p) => p.functionCall).map((p) => ({ type: "tool_use", name: p.functionCall.name, input: p.functionCall.args || {} }));
  const usage = data.usageMetadata || {};
  return { content, ms: Date.now() - t0, cents: costCents(model, usage, config, new Date()), usage };
}

const pct = (n, d) => (d ? `${Math.round((n * 1000) / d) / 10}%` : "n/a");

async function main(argv) {
  const file = argv.find((a) => !a.startsWith("--"));
  const opt = (k, d) => (argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1] || d;
  const key = process.env.GEMINI_API_KEY;
  if (!file || !key) {
    console.error("usage: GEMINI_API_KEY=... node scripts/eval/autofill_models.mjs steps.json [--models=a,b] [--limit=N]");
    return 2;
  }
  const models = opt("models", `${FLASH_LITE},${CONFIG.TASKS.autofill.model}`).split(",");
  const steps = JSON.parse(readFileSync(file, "utf8")).steps.slice(0, Number(opt("limit", "100000")));
  const thinking = opt("thinking", "");
  const per = Object.fromEntries(models.map((m) => [m, { steps: 0, errors: 0, decided: 0, same: 0, movesAgree: 0, cents: 0, ms: 0, differ: [], missed: [], extra: [], prose: [], reworded: [] }]));
  for (const [i, step] of steps.entries()) {
    const base = decisions(step.response), labels = labelsOf(step.messages);
    for (const m of models) {
      const r = per[m];
      try {
        const got = await ask(m, step, key, thinking);
        const c = compare(base, decisions(got.content), labels);
        const where = { step: i, host: step.host, company: step.company };
        r.steps++; r.decided += c.decided; r.same += c.same; r.movesAgree += c.movesAgree ? 1 : 0; r.cents += got.cents; r.ms += got.ms;
        r.differ.push(...c.differ.map((d) => ({ ...where, ...d }))); r.missed.push(...c.missed.map((d) => ({ ...where, ...d })));
        r.extra.push(...c.extra.map((d) => ({ ...where, ...d }))); r.prose.push(...c.prose.map((d) => ({ ...where, ...d })));
        r.reworded.push(...c.reworded.map((d) => ({ ...where, ...d })));
      } catch (e) {
        r.errors++;
        console.error(`step ${i} ${m}: ${e.message}`);
      }
    }
    process.stdout.write(`\r${i + 1}/${steps.length} steps`);
  }
  process.stdout.write("\n");

  const lines = [`# Auto-Apply model comparison`, "", `${steps.length} recorded steps, compared with what production's model did on each.` +
    (thinking ? ` Thinking level: ${thinking} for every model.` : " Thinking level: production's ceiling for autofill."), "",
    "| Model | Steps | Field decisions agreeing | Next move agreeing | Sensitive disagreements | Missed / extra fields | Cost per step | Time per step |",
    "|---|---|---|---|---|---|---|---|"];
  for (const m of models) {
    const r = per[m];
    lines.push(`| ${m} | ${r.steps} (${r.errors} errors) | ${pct(r.same, r.decided)} | ${pct(r.movesAgree, r.steps)} | ${r.differ.filter((d) => d.sensitive).length} | ` +
      `${r.missed.length} / ${r.extra.length} | ${r.steps ? (r.cents / r.steps).toFixed(3) : "n/a"}c | ${r.steps ? Math.round(r.ms / r.steps) : "n/a"} ms |`);
  }
  lines.push("", "The production model's own row is the bar: how often it agrees with itself on a second try.",
    "Suggested rule for switching: the cheaper model's field agreement within 3 points of that bar, no sensitive disagreements, and its prose judged no worse below.", "");
  for (const m of models) {
    const r = per[m];
    lines.push(`## ${m}`, "", "### Sensitive disagreements", "");
    for (const d of r.differ.filter((x) => x.sensitive)) lines.push(`- step ${d.step} (${d.company}) "${d.label}": recorded **${d.base}**, this model **${d.cand}**`);
    lines.push("", "### Other disagreements", "");
    for (const d of r.differ.filter((x) => !x.sensitive).slice(0, 60)) lines.push(`- step ${d.step} (${d.company}) "${d.label}": recorded ${d.base} / this model ${d.cand}`);
    lines.push("", "### Same answer, written differently (counted as agreeing)", "");
    for (const d of r.reworded.slice(0, 40)) lines.push(`- step ${d.step} (${d.company}) "${d.label}": ${d.base} / ${d.cand}`);
    lines.push("", "### Missed fields (recorded model filled them, this one did not)", "");
    for (const d of r.missed.slice(0, 40)) lines.push(`- step ${d.step} (${d.company}) "${d.label}" = ${d.base}`);
    lines.push("", "### Free-text answers to judge side by side", "");
    for (const d of r.prose.slice(0, 20)) lines.push(`- step ${d.step} (${d.company}) "${d.label}"`, `  - recorded: ${d.base}`, `  - this model: ${d.cand}`);
    lines.push("");
  }
  const dir = dirname(file);
  writeFileSync(join(dir, "eval-report.md"), lines.join("\n"));
  writeFileSync(join(dir, "eval-results.json"), JSON.stringify(per, null, 1));
  console.log(lines.slice(0, 6 + models.length).join("\n"));
  console.log(`\nFull report: ${join(dir, "eval-report.md")}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
