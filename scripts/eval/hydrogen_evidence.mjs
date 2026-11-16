import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { FLASH_LITE } from "../../worker/src/config.js";
import { callModel, costs } from "./hydrogen_eval.mjs";

const hydrogen = "gemini-4-hydrogen";
const variants = [
  { id: "lite-standard", model: FLASH_LITE },
  { id: "hydrogen-standard", model: hydrogen },
  { id: "lite-bounded", model: FLASH_LITE, bounded: true },
  { id: "hydrogen-bounded", model: hydrogen, bounded: true },
];
const cases = [
  {
    id: "warehouse",
    posting: "Help a distribution team investigate records that arrive late.",
    question: "Why does this internship fit your experience?",
    limit: 235,
    facts: [
      "I compared delivery timestamps in a spreadsheet for a campus pantry.",
      "I found and reported 7 missing timestamps. I did not measure time saved.",
    ],
  },
  {
    id: "accessibility",
    posting: "Test public web forms with accessibility specialists.",
    question: "Describe relevant work and what you learned.",
    limit: 240,
    facts: [
      "I added labels to an event form and tested it with a keyboard.",
      "One classmate reached the final button without a mouse. I did not test screen readers.",
    ],
  },
  {
    id: "impact",
    posting: "Write instructions for a volunteer scheduling tool.",
    question: "What measurable improvement did your documentation make?",
    limit: 190,
    facts: [
      "I rewrote the signup instructions.",
      "A volunteer said the new checklist answered their question. I did not collect timing or usage data.",
    ],
  },
  {
    id: "tool-gap",
    posting: "Build Tableau dashboards and explain trends to a policy team.",
    question: "What experience makes you a good fit?",
    limit: 210,
    facts: [
      "I charted attendance in Excel and explained a change in the data to a club treasurer.",
      "I have never used Tableau.",
    ],
  },
  {
    id: "ownership",
    posting: "Coordinate small projects with a design team.",
    question: "Describe your contribution to a team project.",
    limit: 210,
    facts: [
      "Our group of 4 updated the campus map.",
      "I checked building names and suggested a legend. A teammate led the project.",
    ],
  },
  {
    id: "failure",
    posting: "Support an internal development team.",
    question: "Tell us about a mistake and how you responded.",
    limit: 240,
    facts: [
      "I used last semester's version of a CSV and caught the error when the totals disagreed.",
      "I reran the report and added the file date to the checklist. There was no external release.",
    ],
  },
  {
    id: "no-example",
    posting: "Learn how to support laboratory equipment checks.",
    question: "Describe a time you calibrated laboratory equipment.",
    limit: 140,
    facts: [
      "I keep an inventory for my student group.",
      "I have not calibrated laboratory equipment.",
    ],
  },
  {
    id: "short-limit",
    posting: "Help a community garden organize its volunteer data.",
    question: "What skill would you bring to the role?",
    limit: 120,
    facts: [
      "I used filters to clean the signup sheet for a student club.",
      "I showed the coordinator how to repeat it.",
    ],
  },
];
const confirmation = [
  {
    id: "shared-ownership",
    posting: "Maintain validation tools and report data errors.",
    question: "Tell us what you personally built.",
    limit: 180,
    facts: [
      "A teammate wrote the validation script.",
      "I supplied three sample files and documented one parsing error.",
    ],
  },
  {
    id: "estimated-impact",
    posting: "Improve a campus operations process.",
    question: "How much faster was the process after your change?",
    limit: 150,
    facts: [
      "I combined two intake forms.",
      "Our coordinator expected a speedup. We have not measured elapsed time.",
    ],
  },
  {
    id: "course-vs-job",
    posting: "Assist a team rolling out an internal database.",
    question: "Describe your database experience.",
    limit: 150,
    facts: [
      "In class I wrote SQLite queries using a fictional dataset.",
      "I did not deploy a database.",
    ],
  },
  {
    id: "short-answer-no-fact",
    posting: "Learn how a museum team tracks conservation work.",
    question: "Have you worked in museum conservation?",
    limit: 95,
    facts: ["I cataloged books for a community swap.", "I have not worked in museum conservation."],
  },
];
const standard =
  "Write a specific, honest internship application answer in the candidate's voice. Use their experience and the posting. Sound plain and natural. Avoid clichés, filler and invented facts. Respect the character limit. Return only the answer.";
const bounded =
  "Draft one natural first-person answer. Every claim about the candidate must follow from the numbered facts. Use the posting only for fit. Respect negative evidence and admit when the requested experience or measurement is missing. Aim for at most 80% of the character limit. Return the answer and the fact numbers it relies on.";
const schema = {
  type: "object",
  properties: { answer: { type: "string" }, facts: { type: "array", items: { type: "integer" } } },
  required: ["answer", "facts"],
  additionalProperties: false,
};

export function requestForWriting(example, variant) {
  const prompt = [
    example.question,
    `Limit: ${example.limit} characters.`,
    `Posting: ${example.posting}`,
    "Candidate facts:",
    ...example.facts.map((fact, i) => `${i + 1}. ${fact}`),
  ].join("\n");
  return {
    systemInstruction: { parts: [{ text: variant.bounded ? bounded : standard }] },
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingLevel: "low" },
      ...(variant.bounded
        ? { responseMimeType: "application/json", responseJsonSchema: schema }
        : {}),
    },
  };
}

export function checkWriting(example, text, structured) {
  let answer = text?.trim() || "";
  const issues = [];
  if (structured) {
    let data;
    try {
      data = JSON.parse(answer);
    } catch {
      return { answer: "", issues: ["Invalid JSON"] };
    }
    answer = typeof data?.answer === "string" ? data.answer.trim() : "";
    const refs = data?.facts;
    if (
      !Array.isArray(refs) ||
      !refs.length ||
      new Set(refs).size !== refs.length ||
      refs.some((ref) => !Number.isInteger(ref) || ref < 1 || ref > example.facts.length)
    ) {
      issues.push("Missing or invalid evidence references");
    }
  }
  if (!answer || answer.length > example.limit) issues.push("Empty or over length");
  const numbers = (value) => value.match(/\b\d+(?:[.,]\d+)?%?/g) || [];
  const available = new Set(numbers(example.facts.join(" ")));
  if (numbers(answer).some((number) => !available.has(number))) issues.push("Unsupported number");
  return { answer, issues };
}

async function main() {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean" },
      case: { type: "string" },
      confirmation: { type: "boolean" },
    },
  });
  const cohort = values.confirmation ? confirmation : cases;
  const selected = values.case ? cohort.filter(({ id }) => id === values.case) : cohort;
  const arms = values.confirmation ? variants.filter((variant) => variant.bounded) : variants;
  if (!selected.length) throw new Error("Unknown case");
  if (!values.live) {
    console.log(`${selected.length * arms.length} planned calls.`);
    return;
  }
  const key = process.env.INTERNSCOUT_GEMINI_EVAL_KEY || process.env.GEMINI_API_KEY;
  if (!key) throw new Error("Set the Gemini evaluation key");
  const path = new URL(`./hydrogen-run-evidence-${randomUUID()}/`, import.meta.url);
  await mkdir(path);
  console.log(path.href);
  const rows = [];
  const blind = [];
  try {
    for (const [index, example] of selected.entries()) {
      const answers = [];
      blind.push({ ...example, answers });
      const offset = index % arms.length;
      for (const variant of [...arms.slice(offset), ...arms.slice(0, offset)]) {
        const reply = await callModel(variant, requestForWriting(example, variant), key);
        const price = costs(variant.model, reply.usage);
        if (reply.error || !price)
          throw new Error(`${example.id}: ${reply.error ?? "Missing usage"}`);
        const { answer, issues } = checkWriting(example, reply.text, variant.bounded);
        const id = randomUUID();
        answers.push({ id, answer });
        rows.push({
          id,
          case: example.id,
          variant: variant.id,
          ms: reply.ms,
          usage: reply.usage,
          cost: price,
          issues,
        });
        console.log(`${rows.length}/${selected.length * arms.length} ${example.id} ${variant.id}`);
      }
      answers.sort((left, right) => left.id.localeCompare(right.id));
    }
  } finally {
    await writeFile(new URL("results.json", path), JSON.stringify(rows, null, 2));
    await writeFile(new URL("blind.json", path), JSON.stringify(blind, null, 2));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
