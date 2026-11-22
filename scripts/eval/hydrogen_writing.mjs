import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { FLASH, FLASH_LITE } from "../../worker/src/config.js";
import { callModel, costs } from "./hydrogen_eval.mjs";
import { writingCases } from "./hydrogen_writing_cases.mjs";

const hydrogen = "gemini-4-hydrogen";
const variants = [
  { id: "flash-standard", model: FLASH, grounded: false },
  { id: "hydrogen-standard", model: hydrogen, grounded: false },
  { id: "flash-grounded", model: FLASH, grounded: true },
  { id: "hydrogen-grounded", model: hydrogen, grounded: true },
];

const instructions = {
  application: {
    standard:
      "Write a specific, honest internship application answer in the candidate's voice. Use their experience and the posting. Sound plain and natural. Avoid clichés, filler and invented facts. Respect the character limit. Return only the answer.",
    grounded:
      "Answer in first person using only the candidate facts. Pick the most relevant example. Say what the candidate did and the outcome actually observed. Qualify unmeasured impact. Use the posting only to explain fit. Never add numbers, tools, duties, or outcomes. Use plain language and stay within the limit. Output only the answer.",
  },
  resume: {
    standard:
      "Tailor an existing resume bullet to one internship posting. Reword it to use the posting's language where truthful. Never add employers, titles, dates, tools, technologies, numbers, metrics, awards, coursework or responsibilities. Copy every number exactly. Start with a strong verb. Keep the original if it already fits. Output only the bullet and respect the word limit.",
    grounded:
      "Rewrite one resume bullet. Lead with the most relevant verified action, then its evidence. Preserve every concrete fact and exact number. Use posting terms only where the original bullet supports them. Add no tools, scope, ownership or results. Start with a verb. Output one plain bullet within the word limit.",
  },
};

function buildRequest(example, variant) {
  const instruction = instructions[example.kind][variant.grounded ? "grounded" : "standard"];
  const unit = example.kind === "application" ? "characters" : "words";
  return {
    systemInstruction: { parts: [{ text: instruction }] },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: [
              `Posting: ${example.posting}`,
              `Candidate facts:\n${example.facts.join("\n")}`,
              `Task: ${example.question}`,
              `Maximum length: ${example.limit} ${unit}.`,
            ].join("\n\n"),
          },
        ],
      },
    ],
    generationConfig: {
      maxOutputTokens: 2048,
      thinkingConfig: {
        thinkingLevel: variant.thinking ?? (example.kind === "application" ? "low" : "medium"),
      },
    },
  };
}

async function collect(variant, request, key) {
  const start = performance.now();
  let result = await callModel(variant, request, key);
  if (result.error === "HTTP 429") {
    await sleep(12_000);
    result = await callModel(variant, request, key);
    result.retried = true;
    result.ms = performance.now() - start;
  }
  return result;
}

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean" },
      case: { type: "string" },
      "resume-low": { type: "boolean" },
      "application-lite": { type: "boolean" },
    },
  });
  if (values["resume-low"] && values["application-lite"]) {
    throw new Error("Choose one follow-up cohort at a time.");
  }
  let cohort = writingCases;
  let selectedVariants = variants;
  if (values["resume-low"]) {
    cohort = writingCases.filter((example) => example.kind === "resume");
    selectedVariants = variants
      .filter((variant) => variant.grounded)
      .map((variant) => ({
        ...variant,
        id: variant.id + "-low",
        thinking: "low",
      }));
  } else if (values["application-lite"]) {
    cohort = writingCases.filter((example) => example.kind === "application");
    selectedVariants = [{ id: "flash-lite-grounded", model: FLASH_LITE, grounded: true }];
  }
  const examples = values.case ? cohort.filter((example) => example.id === values.case) : cohort;
  if (!examples.length) throw new Error("Unknown writing case.");
  const planned = examples.length * selectedVariants.length;
  if (!values.live) {
    console.log(
      `Dry run: ${examples.length} fictional writing prompts × ${selectedVariants.length} variants = ${planned} planned calls.`,
    );
    return;
  }

  const key = process.env.INTERNSCOUT_GEMINI_EVAL_KEY?.trim() || process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("Set a Gemini API key in this process.");
  const directory = new URL(`./hydrogen-run-writing-${randomUUID()}/`, import.meta.url);
  await mkdir(directory);
  console.log(`Writing run: ${fileURLToPath(directory)}`);
  const blind = [];
  const rows = [];
  const started = new Date().toISOString();
  try {
    for (const [index, example] of examples.entries()) {
      const answers = [];
      blind.push({ ...example, answers });
      const offset = index % selectedVariants.length;
      for (const variant of [
        ...selectedVariants.slice(offset),
        ...selectedVariants.slice(0, offset),
      ]) {
        const request = buildRequest(example, variant);
        const start = performance.now();
        const result = await collect(variant, request, key).catch(() => ({
          error: "Network, timeout, or malformed stream",
          ms: performance.now() - start,
        }));
        const id = randomUUID();
        const text = (result.text ?? "").trim();
        const length =
          example.kind === "application" ? text.length : text.split(/\s+/).filter(Boolean).length;
        answers.push({ id, text });
        rows.push({
          id,
          case: example.id,
          kind: example.kind,
          variant: variant.id,
          modelVersion: result.modelVersion,
          ms: Math.round(result.ms),
          finish: result.finish,
          error: result.error,
          retried: result.retried ?? false,
          usage: result.usage,
          cost: costs(variant.model, result.usage),
          length,
          withinLimit: length > 0 && length <= example.limit,
        });
        console.log(`${rows.length}/${planned} · ${example.id} · ${result.error ?? result.finish}`);
        if (result.error?.startsWith("HTTP ") || !result.finish) {
          throw new Error("A provider request failed. Check the partial report.");
        }
      }
    }
  } finally {
    for (const entry of blind) entry.answers.sort((a, b) => a.id.localeCompare(b.id));
    await writeFile(new URL("blind-prose.json", directory), JSON.stringify(blind, null, 2));
    await writeFile(
      new URL("results.json", directory),
      JSON.stringify(
        { started, planned, valid: rows.filter((row) => !row.error).length, rows },
        null,
        2,
      ),
    );
  }
  if (rows.some((row) => row.error || !row.cost)) {
    throw new Error("Some responses were incomplete or lacked token usage. See the saved report.");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
