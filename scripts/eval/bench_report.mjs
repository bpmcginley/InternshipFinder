// Scores the benchmark's runs against the key and prints the tables for haiku-vs-flash.md. Writes
// bench-summary.json (numbers) and bench-tables.md (tables), both git-ignored.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { load, save, HERE } from "./bench_io.mjs";
import * as L from "./bench_lib.mjs";

const { CONFIG } = await import("../../worker/src/config.js");
const { CONFIGS } = await import("./bench_run.mjs");

const STEPS_PER_APP = 3.2;          // measured in production, 2026-09-30 (worker/src/config.js COSTS)
const MONTHLY = [19, 300, 3000];    // September's real Auto-Apply runs, 10x, 100x
const BASE = "flash-low";
// Decided before the results were read (the task's rule, made concrete): a config qualifies if its
// objective accuracy is no more than 2 points under the baseline's, it has no more sensitive errors
// and no more invalid tool calls than the baseline over the same runs, and its free-text answers are
// not worse: judged overall score no more than 0.15 under the baseline's (the judge's noise between a
// config's two runs is about that), and no more invented claims.
const RULE = { accuracyPts: 2, freeTextTolerance: 0.15 };

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pctl = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const pct = (n, d) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
const usd = (c) => `$${(c / 100).toFixed(c < 100 ? 4 : 2)}`;
const usd2 = (c) => `$${(c / 100).toFixed(2)}`;

// USD per 1M tokens for the cost model, now and from 2027-01-01.
function prices(cfg) {
  if (cfg.provider === "gemini") {
    const [now, later] = CONFIG.PRICES[cfg.model];
    return { now: { ...now, write: now.input }, later: { ...later, write: later.input } };
  }
  const p = L.CLAUDE_PRICES[cfg.model];
  const x = { input: p.input, output: p.output, cached: p.cached, write: p.input * 1.25 };
  return { now: x, later: x };
}

export async function report() {
  const steps = load("steps"), key = L.applyKeyFixes(load("key")), runs = load("runs"), judge = load("judge", {});
  const byKey = Object.fromEntries(steps.map((s) => [s.key, s]));
  const before = Object.fromEntries(steps.map((s) => [s.key, Object.fromEntries(s.fields.map((f) => [f.ref, f.value]))]));
  const configs = Object.keys(CONFIGS).filter((c) => runs[c]);
  const S = {};
  // The fixed opening (rules + profile + job, cached by Claude at the system prompt's breakpoint),
  // per form, from Claude's own usage; used to model what caching saves over an application.
  const prefixShare = {};
  for (const c of configs.filter((x) => CONFIGS[x].provider === "anthropic")) for (const run of Object.keys(runs[c])) for (const [fk, r] of Object.entries(runs[c][run])) {
    if (r.error || !r.step1.tokens) continue;
    const t = r.step1.tokens, pre = t.written || t.cached;
    if (pre && t.prompt) prefixShare[fk] = pre / t.prompt;
  }
  const share = mean(Object.values(prefixShare)) || 0.75;

  for (const c of configs) {
    const cfg = CONFIGS[c], P = prices(cfg);
    const agg = { label: cfg.label, tasks: 0, errors: [], refusals: 0, objective: 0, correct: 0, perRun: {}, sensitive: [], missed: [], hallucinated: [], wrongTicks: [],
      invalid: 0, invalidList: [], malformed: 0, bracketed: 0, asIs: 0, calls: 0, misused: 0, counted: {}, skipAnswered: [], prefillBroken: [], prefillFixed: 0, prefillWrong: 0, wrong: [],
      ms: [], cents: [], later: [], uncached: [], uncachedLater: [], app: { now: [], later: [] }, appCached: { now: [], later: [] },
      tokens: { prompt: [], output: [] }, stops: {}, consistency: { n: 0, same: 0 }, two: { reached: 0, eligible: 0, outcomes: {}, before: { n: 0, ok: 0 }, after: { n: 0, ok: 0 }, invalid: 0, bracketed: 0, redundant: 0, skipAnswered: 0, cents: [] } };
    for (const run of Object.keys(runs[c])) {
      const pr = (agg.perRun[run] = { objective: 0, correct: 0 });
      for (const [fk, r] of Object.entries(runs[c][run])) {
        agg.tasks++;
        if (r.error) { agg.errors.push({ fk, run, error: r.error }); if (r.refusal) agg.refusals++; continue; }
        const k = key[fk], s1 = r.step1;
        const sc = L.scoreForm(k, before[fk], r.after1, s1.calls);
        agg.objective += sc.objective; agg.correct += sc.correct; pr.objective += sc.objective; pr.correct += sc.correct;
        for (const x of sc.counted) (agg.counted[`${fk}|${x.ref}`] = agg.counted[`${fk}|${x.ref}`] || []).push(x.ok);
        agg.misused += sc.misused;
        const where = (x) => ({ ...x, fk, run, company: byKey[fk].job.company });
        agg.sensitive.push(...sc.sensitiveWrong.map(where)); agg.missed.push(...sc.missedRequired.map(where)); agg.hallucinated.push(...sc.hallucinated.map(where));
        agg.wrongTicks.push(...sc.wrongTicks.map(where)); agg.wrong.push(...sc.wrong.map(where)); agg.prefillBroken.push(...sc.prefillBroken.map(where));
        agg.prefillFixed += sc.prefillFixed; agg.prefillWrong += sc.prefillWrong;
        agg.skipAnswered.push(...sc.skipAnswered.map(where));
        agg.invalid += sc.invalid; agg.malformed += sc.malformed; agg.calls += sc.calls;
        agg.invalidList.push(...s1.calls.filter((x) => !x.ok && !x.control).map((x) => where({ name: x.name, ref: x.ref, error: x.error })));
        agg.bracketed += s1.calls.filter((x) => x.bracketed).length;
        agg.asIs += s1.calls.filter((x) => (!x.ok && !x.control) || x.bracketed).length;
        agg.stops[s1.stopKind || "continue"] = (agg.stops[s1.stopKind || "continue"] || 0) + 1;
        agg.ms.push(s1.ms); agg.cents.push(s1.cents); agg.later.push(s1.later);
        const t = s1.tokens;
        agg.tokens.prompt.push(t.prompt); agg.tokens.output.push(t.output);
        const unc = (p) => (t.prompt * p.input + t.output * p.output) / 1e4;
        agg.uncached.push(unc(P.now)); agg.uncachedLater.push(unc(P.later));
        agg.app.now.push(unc(P.now) * STEPS_PER_APP); agg.app.later.push(unc(P.later) * STEPS_PER_APP);
        const tk = { prompt: t.prompt, output: t.output, prefix: Math.round(t.prompt * (prefixShare[fk] || share)) };
        agg.appCached.now.push(L.appCents(tk, STEPS_PER_APP, P.now)); agg.appCached.later.push(L.appCents(tk, STEPS_PER_APP, P.later));
        // Second step (subset).
        if (r.step2) {
          agg.two.reached++;
          agg.two.outcomes[r.step2.stopKind || "continue"] = (agg.two.outcomes[r.step2.stopKind || "continue"] || 0) + 1;
          const s2 = L.scoreForm(k, before[fk], r.after2, r.step2.calls);
          agg.two.before.n += sc.objective; agg.two.before.ok += sc.correct; agg.two.after.n += s2.objective; agg.two.after.ok += s2.correct;
          agg.two.invalid += s2.invalid; agg.two.bracketed += r.step2.calls.filter((x) => x.bracketed).length;
          agg.two.skipAnswered += s2.skipAnswered.length;
          // Fields step 1 had already answered right that step 2 wrote again.
          agg.two.redundant += r.step2.calls.filter((x) => x.ok && x.ref && ["fill", "select", "check"].includes(x.name) && k[String(x.ref).replace(/^\[|\]$/g, "")] && L.matches(r.after1[String(x.ref).replace(/^\[|\]$/g, "")], k[String(x.ref).replace(/^\[|\]$/g, "")])).length;
          agg.two.cents.push(r.step2.cents);
        }
      }
    }
    // Self-consistency, run 1 against run 2 on the same form.
    const rk = Object.keys(runs[c]);
    if (rk.length >= 2) for (const fk of Object.keys(runs[c][rk[0]])) {
      const a = runs[c][rk[0]][fk], b = runs[c][rk[1]] && runs[c][rk[1]][fk];
      if (!a || !b || a.error || b.error) continue;
      const x = L.consistency(key[fk], a.after1, b.after1);
      agg.consistency.n += x.n; agg.consistency.same += x.same;
    }
    // Free text, from the judge.
    const rows = Object.values(judge).flat().filter((x) => x.config === c);
    agg.free = { n: rows.length, overall: mean(rows.map((x) => x.overall)), relevance: mean(rows.map((x) => x.relevance)), truthfulness: mean(rows.map((x) => x.truthfulness)),
      fit: mean(rows.map((x) => x.fit)), invented: rows.reduce((a, x) => a + (x.invented || []).length, 0), answersWithInvented: rows.filter((x) => (x.invented || []).length).length,
      perRun: Object.fromEntries(Object.keys(runs[c]).map((run) => [run, mean(rows.filter((x) => String(x.run) === String(run)).map((x) => x.overall))])),
      chars: mean(rows.map((x) => x.chars)) };
    agg.accuracy = agg.objective ? (100 * agg.correct) / agg.objective : 0;
    S[c] = agg;
  }
  // Accuracy over the same fields for every config: the (form, field) pairs every config had in its
  // count. The model's share depends only on the form and fastFill, so with every run complete this is
  // all of them; a config with missing or errored runs would otherwise be scored on a different set
  // (the first tables, written while the runs were still going, compared 162 fields with 146).
  const common = Object.keys(S[configs[0]].counted).filter((id) => configs.every((c) => S[c].counted[id]));
  for (const c of configs) {
    const oks = common.flatMap((id) => S[c].counted[id]);
    S[c].common = { n: oks.length, ok: oks.filter(Boolean).length, fields: common.length };
    S[c].commonAccuracy = oks.length ? (100 * S[c].common.ok) / oks.length : 0;
  }
  // Free text, paired: on each question, this config's mean overall minus the baseline's.
  for (const c of configs) {
    const diffs = [];
    for (const rows of Object.values(judge)) {
      for (const q of [...new Set(rows.map((x) => x.ref))]) {
        const mine = rows.filter((x) => x.ref === q && x.config === c), base = rows.filter((x) => x.ref === q && x.config === BASE);
        if (mine.length && base.length) diffs.push(mean(mine.map((x) => x.overall)) - mean(base.map((x) => x.overall)));
      }
    }
    S[c].free.paired = { n: diffs.length, diff: mean(diffs), worse: diffs.filter((d) => d < 0).length, better: diffs.filter((d) => d > 0).length };
  }
  // Decision.
  const b = S[BASE];
  const graded = b.free.n > 0;
  const verdict = {};
  for (const c of configs) {
    const a = S[c];
    // Free text is a failed check, not a pass, when the judge has not run: the rule needs it.
    const checks = {
      accuracy: a.commonAccuracy >= b.commonAccuracy - RULE.accuracyPts,
      sensitive: a.sensitive.length <= b.sensitive.length,
      invalidAsIs: a.asIs <= b.asIs,
      invalidFixed: a.invalid <= b.invalid,
      freeText: graded && a.free.n > 0 && a.free.overall >= b.free.overall - RULE.freeTextTolerance && a.free.invented <= b.free.invented,
      noErrors: a.errors.length === 0,
    };
    const qualifies = Object.values(checks).every(Boolean);
    const qualifiesWithFix = Object.entries(checks).every(([k, v]) => k === "invalidAsIs" || v);
    verdict[c] = { checks, qualifies, qualifiesWithFix, costApp: mean(a.app.now), costAppLater: mean(a.app.later) };
  }
  const byCost = (x, y) => verdict[x].costApp - verdict[y].costApp;
  const qualifying = configs.filter((c) => verdict[c].qualifies).sort(byCost);
  const qualifyingFixed = configs.filter((c) => verdict[c].qualifiesWithFix).sort(byCost);
  const pick = qualifying[0] || BASE, pickFixed = qualifyingFixed[0] || BASE;

  const T = [];
  T.push("## Main results (first step on every form, two runs each)", "",
    "| Config | Objective accuracy (same fields for all) | Sensitive errors | Missed required | Invented values | Invalid calls, bracket fix / as-is | Clicks on fields | Human-only questions answered | Free text (1-5) | Invented claims in free text | Consistency | Cost per step | Cost per application now / 2027 | Latency p50 / p90 |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const c of configs) {
    const a = S[c];
    T.push(`| ${c} | ${a.commonAccuracy.toFixed(1)}% (${a.common.ok}/${a.common.n}) | ${a.sensitive.length} | ${a.missed.length} | ${a.hallucinated.length + a.wrongTicks.length} | ${a.invalid} / ${a.asIs} of ${a.calls} | ${a.misused} | ${a.skipAnswered.length} | ` +
      `${a.free.n ? a.free.overall.toFixed(2) : "not graded"} (${a.free.n}) | ${a.free.invented} | ${pct(a.consistency.same, a.consistency.n)} | ${usd(mean(a.uncached))} | ${usd(mean(a.app.now))} / ${usd(mean(a.app.later))} | ${(pctl(a.ms, 0.5) / 1000).toFixed(1)} s / ${(pctl(a.ms, 0.9) / 1000).toFixed(1)} s |`);
  }
  T.push("", `Accuracy is over the ${common.length} (form, field) pairs that are the model's share for every config, in both runs (each config's own count: ${configs.map((c) => `${c} ${S[c].correct}/${S[c].objective}`).join(", ")}).`,
    `Sensitive errors include right pre-filled answers the model overwrote on a sensitive field (EEO, authorization, ...). "Clicks on fields": click calls aimed at a form field instead of a button; on a radio group the click lands on the first option. "Human-only questions answered": fields the key marks skip (only the student can answer: a consent, a commitment the profile does not make, a fact it lacks) that the model filled anyway; not in the accuracy count.`);
  T.push("", `Cost per step is uncached (every input token at full price, thinking billed as output), from each call's real token counts. Per application = ${STEPS_PER_APP} steps.`,
    `"As-is" invalid calls add the calls whose ref was written with brackets ("[0:6]"), which production's execTool rejects today; the bench strips the brackets, so everything else is measured as if that one-line fix were in.`, "",
    "## Accuracy per run", "", "| Config | Run 1 | Run 2 | Errors / refusals |", "|---|---|---|---|");
  for (const c of configs) {
    const a = S[c], pr = Object.values(a.perRun);
    T.push(`| ${c} | ${pr.map((p) => pct(p.correct, p.objective)).join(" | ")} | ${a.errors.length} / ${a.refusals} |`);
  }
  T.push("", "## Cost (USD)", "", "| Config | Measured per step (with whatever caching happened) | Uncached per step | Per application, uncached now / 2027 | Per application, fixed opening cached after step 1, now / 2027 | Mean prompt / output tokens |", "|---|---|---|---|---|---|");
  for (const c of configs) {
    const a = S[c];
    T.push(`| ${c} | ${usd(mean(a.cents))} | ${usd(mean(a.uncached))} | ${usd(mean(a.app.now))} / ${usd(mean(a.app.later))} | ${usd(mean(a.appCached.now))} / ${usd(mean(a.appCached.later))} | ${Math.round(mean(a.tokens.prompt))} / ${Math.round(mean(a.tokens.output))} |`);
  }
  T.push("", "Per month (uncached per-application cost; the cached column above is the floor):", "", `| Config | ${MONTHLY.map((n) => `${n.toLocaleString()} apps now / 2027`).join(" | ")} |`, `|---|${MONTHLY.map(() => "---").join("|")}|`);
  for (const c of configs) {
    const a = S[c];
    T.push(`| ${c} | ${MONTHLY.map((n) => `${usd2(n * mean(a.app.now))} / ${usd2(n * mean(a.app.later))}`).join(" | ")} |`);
  }
  T.push("", "## Second step (subset)", "", "| Config | Reached step 2 | Step-1 outcome (all forms) | Step-2 outcome | Accuracy on those forms after step 1 / after step 2 | New invalid calls, bracket fix / as-is | Re-writes of right answers | Human-only questions answered by the end |", "|---|---|---|---|---|---|---|---|");
  for (const c of configs) {
    const a = S[c], t = a.two;
    T.push(`| ${c} | ${t.reached} | ${Object.entries(a.stops).map(([k, v]) => `${k} ${v}`).join(", ")} | ${Object.entries(t.outcomes).map(([k, v]) => `${k} ${v}`).join(", ")} | ${pct(t.before.ok, t.before.n)} / ${pct(t.after.ok, t.after.n)} | ${t.invalid} / ${t.invalid + t.bracketed} | ${t.redundant} | ${t.skipAnswered} |`);
  }
  T.push("", "## Free text (Claude Opus 5.5 as a blind judge)", "");
  if (!graded) T.push("**Not graded: bench-judge.json is missing (run `form_bench.mjs judge`). The decision rule fails every config on free text until it is.**", "");
  T.push("| Config | Answers | Overall | Relevance | Truthfulness | Fit | Invented claims (answers with any) | Mean length (chars) | Overall run 1 / run 2 | Paired vs flash-low: mean diff over questions (worse / better) |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const c of configs) {
    const f = S[c].free, pd = f.paired;
    T.push(`| ${c} | ${f.n} | ${f.overall.toFixed(2)} | ${f.relevance.toFixed(2)} | ${f.truthfulness.toFixed(2)} | ${f.fit.toFixed(2)} | ${f.invented} (${f.answersWithInvented}) | ${Math.round(f.chars)} | ${Object.values(f.perRun).map((x) => x.toFixed(2)).join(" / ")} | ${c === BASE ? "-" : `${pd.diff >= 0 ? "+" : ""}${pd.diff.toFixed(2)} over ${pd.n} (${pd.worse} / ${pd.better})`} |`);
  }
  T.push("", "## Decision rule", "", "| Config | Accuracy within 2 pts | Sensitive errors <= baseline | Invalid calls <= baseline, as-is | Invalid calls <= baseline, bracket fix | Free text not worse | No errors | Qualifies as-is / with the bracket fix | Cost per application now |", "|---|---|---|---|---|---|---|---|---|");
  for (const c of configs) {
    const v = verdict[c], k = v.checks, y = (x) => (x ? "yes" : "**no**");
    T.push(`| ${c} | ${y(k.accuracy)} | ${y(k.sensitive)} | ${y(k.invalidAsIs)} | ${y(k.invalidFixed)} | ${y(k.freeText)} | ${y(k.noErrors)} | ${v.qualifies ? "yes" : "no"} / ${v.qualifiesWithFix ? "yes" : "no"} | ${usd(v.costApp)} |`);
  }
  T.push("", `Cheapest qualifying config: **${pick}** as production is today; **${pickFixed}** with the bracket fix in.`, "");
  for (const c of configs) {
    const a = S[c];
    T.push(`## ${c}: details`, "", "Sensitive errors:", ...a.sensitive.map((x) => `- run ${x.run}, ${x.company} (${x.fk}) "${x.label.slice(0, 140)}": **${String(x.value).slice(0, 120)}**, key ${JSON.stringify(x.expect).slice(0, 160)}${x.prefill ? ` (overwrote the right pre-fill "${String(x.prefill).slice(0, 60)}")` : ""}`),
      "", "Questions only the human can answer (key: skip) that it answered anyway (step 1):", ...a.skipAnswered.map((x) => `- run ${x.run}, ${x.company}: "${x.label.slice(0, 110)}" = ${JSON.stringify(String(x.value ?? "")).slice(0, 90)}`),
      "", "Missed required fields:", ...a.missed.slice(0, 40).map((x) => `- run ${x.run}, ${x.company}: "${x.label.slice(0, 120)}"`),
      "", "Invented values (optional fields the profile can't answer) and wrong ticks:", ...[...a.hallucinated, ...a.wrongTicks].slice(0, 40).map((x) => `- run ${x.run}, ${x.company}: "${x.label.slice(0, 120)}" = ${String(x.value).slice(0, 100)}`),
      "", "Invalid calls:", ...a.invalidList.slice(0, 40).map((x) => `- run ${x.run}, ${x.company}: ${x.name} ${x.ref || ""}: ${x.error}`),
      "", "Pre-filled answers it broke:", ...a.prefillBroken.map((x) => `- run ${x.run}, ${x.company}: "${x.label.slice(0, 100)}" ${x.was} -> ${x.now}`),
      "", `Wrong pre-fills it fixed: ${a.prefillFixed} of ${a.prefillWrong}`, "",
      "Other wrong answers:", ...a.wrong.filter((x) => !x.sensitive).slice(0, 60).map((x) => `- run ${x.run}, ${x.company}: "${x.label.slice(0, 110)}" = ${JSON.stringify(String(x.value ?? "")).slice(0, 90)}; key ${JSON.stringify(x.expect).slice(0, 100)}`),
      "", "Errors:", ...a.errors.map((x) => `- run ${x.run} ${x.fk}: ${x.error}`), "");
  }
  const spend = load("spend", {});
  T.push("## Spend", "", `Gemini ${usd2(spend.gemini || 0)} over ${(spend.calls || {}).gemini || 0} calls; Anthropic ${usd2(spend.anthropic || 0)} over ${(spend.calls || {}).anthropic || 0} calls (Haiku runs, plus Claude Opus 5.5 for the key and the judge).`);
  writeFileSync(join(HERE, "bench-tables.md"), T.join("\n"));
  save("summary", { configs: Object.fromEntries(configs.map((c) => [c, { ...S[c], wrong: S[c].wrong.length, counted: undefined }])), verdict, pick, pickFixed, commonFields: common.length, share, spend });
  console.log(T.slice(0, T.findIndex((l) => l.startsWith("## haiku") || l.startsWith("## flash-low: details"))).join("\n"));
}
