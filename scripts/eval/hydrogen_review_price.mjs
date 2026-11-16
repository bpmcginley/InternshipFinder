import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  buildSystem,
  TOOLS,
  toolResult,
  trimHistory,
} from "../../extension/background/agent-prompt.js";
import { formatSnapshot } from "../../extension/background/agent-snapshot.js";
import { buildGeminiBody } from "../../extension/background/gemini.js";
import { CONFIG, FLASH } from "../../worker/src/config.js";
import { sanitizeRequest } from "../../worker/src/gemini.js";
import { accountLine } from "./bench_io.mjs";
import { fixture } from "./hydrogen_cases.mjs";
import { callModel, costs } from "./hydrogen_eval.mjs";

const cases = [
  {
    id: "school-and-degree",
    fields: [
      ["college", "College or university name", /^Example State University$/i],
      ["degree", "Exact name of your degree", /^Bachelor of Science$/i],
    ],
  },
  {
    id: "role-and-organization",
    fields: [
      ["previous-role", "Title of your most recent internship", /^Software Engineering Intern$/i],
      [
        "previous-org",
        "Company where you did your most recent internship",
        /^Northwind Analytics$/i,
      ],
    ],
  },
  {
    id: "study-and-focus",
    fields: [
      ["current-major", "Major or primary field of study", /^Computer Science$/i],
      ["current-minor", "Declared minor", /^Statistics$/i],
      ["current-gpa", "Cumulative GPA", /^3\.6(?:0)?$/],
    ],
  },
];
const models = [FLASH, "gemini-4-hydrogen"];

function buildTurn(system, messages) {
  trimHistory(messages);
  return sanitizeRequest(
    buildGeminiBody({ system, messages, tools: TOOLS, max_tokens: 8000 }),
    "autofill",
    CONFIG,
  );
}

function assistantContent(parts) {
  let index = 0;
  return parts.flatMap((part) => {
    const signature = part.thoughtSignature ? { _sig: part.thoughtSignature } : {};
    if (part.functionCall) {
      const { name, id, args } = part.functionCall;
      return [
        { type: "tool_use", id: id || `fixture_${index++}`, name, input: args || {}, ...signature },
      ];
    }
    return part.text ? [{ type: "text", text: part.text, ...signature }] : [];
  });
}

function matchesPriorTurn(example, actions) {
  return (
    actions.length === example.fields.length + 1 &&
    actions.at(-1).name === "click" &&
    actions.at(-1).input.ref === "0:next" &&
    example.fields.every(([ref, , expected]) =>
      actions
        .slice(0, -1)
        .some(
          ({ name, input }) =>
            name === "fill" &&
            input.ref === "0:" + ref &&
            typeof input.text === "string" &&
            expected.test(input.text.trim()),
        ),
    )
  );
}

function fixtureMessages(example) {
  const fields = example.fields.map(([ref, label]) => ({
    ref,
    label,
    kind: "text",
    required: true,
  }));
  const { store, job, frame } = fixture({
    id: "verified-review-" + example.id,
    fields,
    buttons: [{ ref: "next", text: "Next" }],
  });
  const system = buildSystem(store, job);
  const snapshot = (page) => ({
    type: "text",
    text: `SNAPSHOT\n${accountLine(store, job.apply_url)}\n${formatSnapshot([page]).text}`,
  });
  const first = { role: "user", content: [snapshot(frame)] };
  const review = snapshot({
    ...frame,
    title: "Review Your Application",
    headings: ["Review Your Application"],
    reviewStep: true,
    elements: [],
    buttons: [{ ref: "submit", text: "Submit Application", blocked: true }],
    text: "All required fields are complete. No validation errors remain.",
  });
  return { system, first, review };
}

function metrics(model, response) {
  return {
    ms: response.ms,
    usage: response.usage,
    cost: costs(model, response.usage),
    error: response.error,
    finish: response.finish,
    modelVersion: response.modelVersion,
  };
}

async function main() {
  const { values } = parseArgs({ options: { live: { type: "boolean" } } });
  if (!values.live) {
    console.log(
      `Dry run. ${cases.length} fictional applications × ${models.length} models × up to 2 turns = at most ${cases.length * models.length * 2} calls.`,
    );
    for (const example of cases) {
      const { system, first } = fixtureMessages(example);
      console.log(
        example.id,
        Buffer.byteLength(JSON.stringify(buildTurn(system, [first]))),
        "first-turn request bytes",
      );
    }
    return;
  }

  const key = process.env.INTERNSCOUT_GEMINI_EVAL_KEY?.trim() || process.env.GEMINI_API_KEY?.trim();
  if (!key)
    throw new Error("Set GEMINI_API_KEY or INTERNSCOUT_GEMINI_EVAL_KEY to run the benchmark.");
  const output = new URL(`./hydrogen-run-review-${randomUUID()}/`, import.meta.url);
  await mkdir(output);
  console.log(`Results: ${fileURLToPath(output)}`);
  const rows = [];
  try {
    for (const [index, example] of cases.entries()) {
      for (const model of index % 2 ? models.toReversed() : models) {
        const { system, first, review } = fixtureMessages(example);
        const row = { case: example.id, model };
        rows.push(row);
        const prior = await callModel({ model }, buildTurn(system, [first]), key);
        row.prior = metrics(model, prior);
        if (prior.error || !row.prior.cost) throw new Error(`First turn failed for ${model}.`);
        const assistant = assistantContent(prior.parts);
        const actions = assistant.filter((part) => part.type === "tool_use");
        row.qualified = matchesPriorTurn(example, actions);
        if (row.qualified) {
          // A local fixture supplies successful tool responses. It never executes the model's actions.
          const result = await callModel(
            { model },
            buildTurn(system, [
              first,
              { role: "assistant", content: assistant },
              {
                role: "user",
                content: [...actions.map(({ id }) => toolResult(id, { ok: true })), review],
              },
            ]),
            key,
          );
          row.review = {
            ...metrics(model, result),
            readied: result.calls?.length === 1 && result.calls[0].name === "ready_to_submit",
          };
          if (result.error || !row.review.cost) throw new Error(`Review turn failed for ${model}.`);
        }
        console.log(
          `${example.id} · ${model} · qualified ${row.qualified} · ready ${row.review?.readied ?? "not tested"}`,
        );
      }
    }
  } finally {
    await writeFile(new URL("results.json", output), JSON.stringify(rows, null, 2));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
