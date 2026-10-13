// Offline Auto-Apply benchmark: real application forms, a fictional student, known-right answers.
// Decides whether a cheaper model (Claude Haiku 5.5) can fill forms as well as production's Gemini 3.8
// Flash, without recording anyone's real applications. See scripts/eval/README.md ("Offline form
// benchmark") for how to run it and haiku-vs-flash.md for the first results.
//
//   node scripts/eval/form_bench.mjs fetch            pick ~30 real open postings and read their forms
//   node scripts/eval/form_bench.mjs snap             render them, run the extension's fastFill + snapshot
//   ANTHROPIC_API_KEY=... node ... key                answer key (rules, then Claude Opus for custom questions)
//   GEMINI_API_KEY=... ANTHROPIC_API_KEY=... node ... run [--configs=a,b] [--runs=2] [--two=10]
//                                                     the first step on every form, applied in Chrome; on
//                                                     --two forms a second step on the page step 1 left
//   ANTHROPIC_API_KEY=... node ... judge              free-text answers graded blind by Claude Opus
//   node scripts/eval/form_bench.mjs report           scores, cost, the decision rule (bench-tables.md)
//
// Every request is built by production's own code: buildSystem / formatSnapshot / preFilledLine /
// trimHistory / TOOLS from extension/background/agent.js, buildGeminiBody from background/gemini.js and
// the Worker's sanitizeRequest + costCents. Claude gets the same system, messages and tools through the
// Messages API (autofill_models.mjs askClaude). Spend on both providers is kept in bench-spend.json and
// every call is refused once the total reaches --cap (default $14.50, under the $15 Bruce allowed).
//
// Data files (all git-ignored, scripts/eval/*.json): bench-forms, bench-steps, bench-key, bench-runs,
// bench-judge, bench-spend. They hold only the fictional profile and public postings.
import { pathToFileURL } from "node:url";
import { ROOT, load, save, sleep, accountLine, factsFor } from "./bench_io.mjs";

const { buildSystem, formatSnapshot, preFilledLine, trimHistory } = await import("../../extension/background/agent.js");
const { benchStore, RESUME_FILE } = await import("./bench_profile.mjs");
const F = await import("./bench_forms.mjs");

// ---------- fetch: pick the postings ----------
const QUOTAS = {
  greenhouse: { swe: 3, data: 3, finance: 3, marketing: 3 },
  lever: { swe: 3, data: 2, finance: 2, marketing: 2 },
  ashby: { swe: 3, data: 2, finance: 2, marketing: 2 },
};

async function phaseFetch() {
  const cands = F.listingCandidates(ROOT);
  const forms = [], usedCo = new Set(), log = [];
  for (const [ats, cells] of Object.entries(QUOTAS)) {
    for (const [cat, n] of Object.entries(cells)) {
      const pool = cands.filter((c) => c.ats === ats && c.cat === cat);
      let got = 0, tries = 0;
      for (const c of pool) {
        if (got >= n || tries >= 25) break;
        const co = c.listing.company_name;
        if (usedCo.has(co)) continue;
        tries++;
        let src;
        try { src = await F.fetchSource(c); } catch (e) { log.push(`skip ${ats} ${co}: ${e.message}`); await sleep(400); continue; }
        await sleep(400);
        const qs = F.questionsOf(ats, src), custom = F.customQuestions(qs), free = F.freeTextQuestions(qs);
        // At least one question beyond the contact block, and, for the first posting of each kind,
        // a free-text one when one turns up in the first few tries.
        if (!custom.length) { log.push(`skip ${ats} ${co}: no custom questions`); continue; }
        if (got === 0 && !free.length && tries <= 6) { log.push(`skip ${ats} ${co}: wanted a free-text question first`); continue; }
        const job = F.jobOf(c);
        forms.push({ key: `${ats}-${c.id.slice(0, 8)}`, ats, cat, token: c.token, postingId: c.id, job, questions: qs,
          custom: custom.length, free: free.length, html: F.renderForm(ats, job, src) });
        usedCo.add(co);
        got++;
        console.log(`${ats} ${cat}: ${co} | ${job.title} (${qs.length} questions, ${custom.length} custom, ${free.length} free text)`);
      }
      if (got < n) console.log(`!! ${ats} ${cat}: only ${got} of ${n}`);
    }
  }
  save("forms", forms);
  console.log(`${forms.length} forms saved; ${forms.filter((f) => f.free).length} with free-text questions.`);
  if (log.length) console.log(log.slice(0, 40).join("\n"));
}

// ---------- snap: the first step's request, as production would build it ----------
async function phaseSnap() {
  const { openBrowser, loadForm, snapshotFrames } = await import("./bench_page.mjs");
  const forms = load("forms");
  const store = benchStore();
  const { browser, close } = await openBrowser();
  const steps = [];
  try {
    for (const f of forms) {
      const facts = factsFor(store, f.job);
      const { page, pre } = await loadForm(browser, f.job.apply_url, f.html, facts, RESUME_FILE);
      const frames = await snapshotFrames(page);
      await page.close();
      const snap = formatSnapshot(frames, {});
      const nothingLeft = globalThis.ISGuard.nothingLeftForAI(frames, pre.length);
      const content = [];
      if (pre.length) content.push({ type: "text", text: preFilledLine(pre, snap.shown) });
      content.push({ type: "text", text: `SNAPSHOT\n${accountLine(store, f.job.apply_url)}\n${snap.text}` });
      const messages = [{ role: "user", content }];
      trimHistory(messages);
      steps.push({ key: f.key, ats: f.ats, cat: f.cat, job: f.job, pre, nothingLeft, hasFinal: snap.hasFinal,
        system: buildSystem(store, f.job), messages, fields: frames[0].elements.map((e) => ({ ...e, ref: `0:${e.ref}` })),
        buttons: frames[0].buttons.map((b) => ({ ...b, ref: `0:${b.ref}` })) });
      console.log(`${f.key}: ${frames[0].elements.length} fields, ${pre.length} pre-filled, final button ${snap.hasFinal ? "blocked" : "MISSING"}${nothingLeft ? ", nothing left for AI" : ""}`);
    }
  } finally { await close(); }
  save("steps", steps);
}

export const PHASES = { fetch: phaseFetch, snap: phaseSnap };

async function main(argv) {
  const phase = argv[0];
  const all = { ...PHASES, ...(await import("./bench_run.mjs")).PHASES };
  if (!all[phase]) { console.error(`usage: node scripts/eval/form_bench.mjs <${Object.keys(all).join("|")}> [options]`); return 2; }
  await all[phase](argv.slice(1));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
