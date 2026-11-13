import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { cases } from "./hydrogen_cases.mjs";
import { callModel, costs, grade, requestFor, variants } from "./hydrogen_eval.mjs";

const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] ?? null;
const average = (values) =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
const round = (value, digits = 1) => (value == null ? null : Number(value.toFixed(digits)));

function summarize(rows) {
  return variants.map((variant) => {
    const attempts = rows.filter((row) => row.variant === variant.id);
    const successful = attempts.filter((row) => !row.error);
    const checks = attempts.flatMap((row) => row.grade?.checks ?? []);
    const issues = attempts.flatMap((row) => row.grade?.issues ?? []);
    const complete = successful.filter(
      (row) => row.grade.checks.every((check) => check.pass) && !row.grade.issues.length,
    );
    const usage = attempts.filter((row) => row.cost).map((row) => row.usage);
    const spendPerPass = (key) => {
      if (!complete.length || attempts.some((row) => !row.cost)) return null;
      return round(attempts.reduce((sum, row) => sum + row.cost[key], 0) / complete.length, 6);
    };
    const meanTokens = (key) => round(average(usage.map((row) => row[key] ?? 0)));
    return {
      variant: variant.id,
      attempts: attempts.length,
      errors: attempts.length - successful.length,
      strictCasePasses: complete.length,
      checkPasses: checks.filter((check) => check.pass).length,
      checks: checks.length,
      criticalMisses: checks.filter((check) => check.critical && !check.pass).length,
      criticalActions: issues.filter((issue) => issue.critical).length,
      allActionIssues: issues.length,
      p50Ms: round(
        percentile(
          successful.map((row) => row.ms),
          0.5,
        ),
      ),
      p95Ms: round(
        percentile(
          successful.map((row) => row.ms),
          0.95,
        ),
      ),
      usageSamples: usage.length,
      meanInputTokens: round(
        average(usage.map((row) => row.promptTokenCount + (row.toolUsePromptTokenCount ?? 0))),
      ),
      meanCacheReadTokens: meanTokens("cachedContentTokenCount"),
      meanTotalTokens: round(
        average(
          usage.map(
            (row) =>
              row.promptTokenCount +
              (row.toolUsePromptTokenCount ?? 0) +
              (row.candidatesTokenCount ?? 0) +
              (row.thoughtsTokenCount ?? 0),
          ),
        ),
      ),
      meanOutputTokens: meanTokens("candidatesTokenCount"),
      meanThinkingTokens: meanTokens("thoughtsTokenCount"),
      meanCurrentUsd: round(
        average(attempts.flatMap((row) => (row.cost ? [row.cost.currentUsd] : []))),
        6,
      ),
      meanJanuaryUsd: round(
        average(attempts.flatMap((row) => (row.cost ? [row.cost.januaryUsd] : []))),
        6,
      ),
      currentUsdPerStrictPass: spendPerPass("currentUsd"),
      januaryUsdPerStrictPass: spendPerPass("januaryUsd"),
    };
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean" },
      reps: { type: "string", default: "2" },
      case: { type: "string" },
    },
  });
  const reps = Number(values.reps);
  const examples = values.case ? cases.filter((example) => example.id === values.case) : cases;
  if (!examples.length || !Number.isInteger(reps) || reps < 1 || reps > 3) {
    throw new Error("Use --reps=1, 2, or 3 and an optional known --case.");
  }
  const requestCount = examples.length * variants.length * reps;
  const plan = examples.map((example) => ({
    example,
    requests: variants.map((variant) => ({ variant, body: requestFor(example, variant) })),
  }));
  if (!values.live) {
    console.log(
      `Dry run. ${examples.length} fictional snapshots × ${variants.length} variants × ${reps} repeats = ${requestCount} planned calls.`,
    );
    console.table(
      plan.map(({ example, requests }) => ({
        case: example.id,
        currentBodyBytes: Buffer.byteLength(JSON.stringify(requests[0].body)),
        compactBodyBytes: Buffer.byteLength(JSON.stringify(requests[2].body)),
        thinking: requests[0].body.generationConfig.thinkingConfig.thinkingLevel,
      })),
    );
    return;
  }

  const key = process.env.INTERNSCOUT_GEMINI_EVAL_KEY;
  if (!key)
    throw new Error(
      "Set INTERNSCOUT_GEMINI_EVAL_KEY in this process to use a Gemini test project.",
    );
  const dir = new URL(`./hydrogen-run-${randomUUID()}/`, import.meta.url);
  await mkdir(dir);
  const rows = [];
  const started = new Date().toISOString();
  console.log(`Running up to ${requestCount} calls. Results: ${fileURLToPath(dir)}`);
  try {
    for (let rep = 0; rep < reps; rep++) {
      for (const [i, { example, requests }] of plan.entries()) {
        const rotation = (rep + i) % requests.length;
        for (const { variant, body } of [
          ...requests.slice(rotation),
          ...requests.slice(0, rotation),
        ]) {
          const start = performance.now();
          let result;
          try {
            result = await callModel(variant, body, key);
          } catch {
            result = {
              error: "Network, timeout, or malformed stream",
              ms: performance.now() - start,
            };
          }
          const declared = new Set(body.tools[0].functionDeclarations.map((tool) => tool.name));
          const scored = result.calls ? grade(example, result.calls, declared) : null;
          const id = randomUUID();
          rows.push({
            id,
            case: example.id,
            guardProbe: example.guardProbe ?? false,
            rep: rep + 1,
            variant: variant.id,
            ms: round(result.ms),
            error: result.error,
            finish: result.finish,
            modelVersion: result.modelVersion,
            usage: result.usage,
            cost: costs(variant.model, result.usage),
            grade: scored ? { checks: scored.checks, issues: scored.issues } : null,
            prose: scored?.prose,
          });
          console.log(
            `${example.id} · ${variant.id} · repeat ${rep + 1} · ${result.error ?? result.finish}`,
          );
          if (result.error?.startsWith("HTTP ") || !result.calls) {
            throw new Error("The provider request failed. The partial report has been saved.");
          }
        }
      }
    }
  } finally {
    const summary = summarize(rows);
    const workflowSummary = summarize(rows.filter((row) => !row.guardProbe));
    const guardProbeSummary = summarize(rows.filter((row) => row.guardProbe));
    const blind = examples
      .filter((example) => example.prose)
      .map((example) => ({
        case: example.id,
        question: example.fields.find((field) => field.ref === example.prose.ref).label,
        rubric: example.prose.rubric,
        answers: rows
          .filter((row) => row.case === example.id)
          .map((row) => ({
            id: row.id,
            text: row.prose ?? "",
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }));
    await writeFile(new URL("blind-prose.json", dir), JSON.stringify(blind, null, 2));
    const metrics = rows.map(({ prose, ...row }) => row);
    await writeFile(
      new URL("results.json", dir),
      JSON.stringify(
        {
          started,
          plannedCalls: requestCount,
          completedPlan: rows.length === requestCount,
          validResponses: rows.filter((row) => !row.error).length,
          summary,
          workflowSummary,
          guardProbeSummary,
          rows: metrics,
        },
        null,
        2,
      ),
    );
    console.table(summary);
  }
  if (rows.some((row) => row.error || !row.cost)) {
    throw new Error(
      "Some responses were incomplete or lacked token usage. Review the saved report before comparing variants.",
    );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
