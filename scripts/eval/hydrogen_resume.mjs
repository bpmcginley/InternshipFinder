// Exercises the extension's real tailoring flow against a local Worker transport.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readSSE, stitchChunks } from "../../extension/background/gemini.js";
import { openDocx } from "../../extension/lib/docx.js";
import { docText } from "../../extension/lib/resume_doc.js";
import { entryBytes } from "../../extension/lib/zip.js";
import { CONFIG } from "../../worker/src/config.js";
import { geminiUrl, sanitizeRequest } from "../../worker/src/gemini.js";
import { costs } from "./hydrogen_eval.mjs";
import { fixtures, setup } from "./hydrogen_resume.fixtures.mjs";
import { arms, prepareRewrite } from "./hydrogen_resume.prompts.mjs";

const { values: args } = parseArgs({
  options: { live: { type: "boolean" }, case: { type: "string" } },
});
const selected = args.case ? fixtures.filter((fixture) => fixture.id === args.case) : fixtures;
if (!selected.length) throw new Error("Unknown synthetic resume case.");
const planned =
  selected.length * arms.length + selected.filter(({ format }) => format === "pdf_layout").length;

async function assertDocx(original, tailored) {
  const before = await openDocx(original);
  const after = await openDocx(tailored);
  const from = before.entries.filter((_, i) => i !== before.idx);
  const to = after.entries.filter((_, i) => i !== after.idx);
  assert.equal(from.length, to.length);
  for (const [i, entry] of from.entries()) {
    assert.equal(entry.name, to[i].name);
    assert.deepEqual(await entryBytes(entry), await entryBytes(to[i]));
  }
}

function assertPdf(bytes) {
  const pdf = bytes.toString("latin1");
  assert.ok(pdf.startsWith("%PDF-"));
  assert.ok(pdf.trimEnd().endsWith("%%EOF"));
  assert.equal((pdf.match(/\/Type \/Page\b/g) || []).length, 1);
}

const totalTokens = (usage) =>
  [
    "promptTokenCount",
    "toolUsePromptTokenCount",
    "candidatesTokenCount",
    "thoughtsTokenCount",
  ].reduce((sum, name) => sum + (usage[name] ?? 0), 0);

function summarize(runs) {
  const groups = new Map();
  for (const run of runs)
    for (const call of run.calls) {
      if (!call.usage || !call.cost) continue;
      const id = call.phase === "layout" ? "shared-flash-layout" : run.variant;
      const key = id + ":" + call.phase;
      if (!groups.has(key)) groups.set(key, { id, phase: call.phase, calls: [] });
      groups.get(key).calls.push(call);
    }
  return [...groups.values()].map(({ id, phase, calls }) => {
    const sort = calls.map(({ ms }) => ms).sort((a, b) => a - b);
    const mid = Math.floor(sort.length / 2);
    const median = sort.length % 2 ? sort[mid] : (sort[mid - 1] + sort[mid]) / 2;
    const mean = (f) => calls.reduce((sum, call) => sum + f(call), 0) / calls.length;
    return {
      variant: id,
      phase,
      measuredCalls: calls.length,
      medianSeconds: Math.round(median) / 1000,
      meanTokens: mean(({ usage }) => totalTokens(usage)),
      meanThinkingTokens: mean(({ usage }) => usage.thoughtsTokenCount ?? 0),
      currentUsdPerThousand: 1000 * mean(({ cost }) => cost.currentUsd),
      januaryUsdPerThousand: 1000 * mean(({ cost }) => cost.januaryUsd),
    };
  });
}

function gradePacket(runs) {
  const variants = {};
  const reviews = runs
    .filter(({ formatPassed }) => formatPassed)
    .map((run) => {
      const id = randomUUID();
      variants[id] = run.variant;
      return { id, case: run.case, diff: run.diff, summary: run.summary };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  return { reviews, variants };
}

async function main() {
  if (!args.live) {
    for (const fixture of selected) {
      const { store } = setup(fixture);
      if (fixture.format === "docx") await openDocx(store.files.resume.b64);
      if (fixture.format === "pdf_layout") assertPdf(Buffer.from(store.files.resume.b64, "base64"));
    }
    console.log(
      "Dry run: " +
        selected.length +
        " fictional resumes × " +
        arms.length +
        " variants, at most " +
        planned +
        " calls including one shared transcription per PDF.",
    );
    return;
  }
  const key = process.env.INTERNSCOUT_GEMINI_EVAL_KEY?.trim() || process.env.GEMINI_API_KEY?.trim();
  if (!key) throw new Error("Set a Gemini API key in this process.");
  const directory = new URL("./hydrogen-run-resume-" + randomUUID() + "/", import.meta.url);
  await mkdir(directory);
  console.log("Resume run: " + fileURLToPath(directory));

  const contexts = new AsyncLocalStorage();
  const storage = (area) => ({
    get: async (name) => ({ [name]: contexts.getStore()[area][name] }),
    set: async (patch) => Object.assign(contexts.getStore()[area], structuredClone(patch)),
  });
  globalThis.chrome = { storage: { local: storage("local"), session: storage("session") } };

  const providerFetch = globalThis.fetch;
  let attempted = 0;
  globalThis.fetch = async (target, init) => {
    const context = contexts.getStore();
    const url = new URL(target);
    assert.ok(context && url.pathname === "/ai" && url.search === "?stream=1");
    assert.ok(attempted < planned, "qualifier request limit reached");
    const input = JSON.parse(init.body);
    assert.equal(input.task, "resume_tailor");
    const system = input.request.systemInstruction.parts[0].text;
    const phase = /^You transcribe/.test(system)
      ? "layout"
      : /Word resume/.test(system)
        ? "word"
        : /JSON sections/.test(system)
          ? "pdf-tailor"
          : "template";
    const { model, level } = phase === "layout" ? arms[0] : context.arm;
    const config = {
      ...CONFIG,
      THINKING_LEVELS: {
        ...CONFIG.THINKING_LEVELS,
        "gemini-4-hydrogen": ["low", "medium", "high"],
      },
      TASKS: {
        ...CONFIG.TASKS,
        resume_tailor: { ...CONFIG.TASKS.resume_tailor, model, thinkingLevel: level },
      },
    };
    const body = sanitizeRequest(input.request, input.task, config);
    assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, level);
    prepareRewrite(body, phase, context.arm.prompt);
    const start = performance.now();
    attempted++;
    const fail = (error) => {
      context.calls.push({ phase, model, level, error });
      // Returning a terminal client error prevents extension retry logic from repeating a paid call.
      return Response.json({ error: "benchmark request failed" }, { status: 400 });
    };
    try {
      const response = await providerFetch(geminiUrl(model, true), {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(55_000),
      });
      if (!response.ok) {
        await response.body?.cancel();
        return fail("HTTP " + response.status);
      }
      const payload = await response.text();
      const replay = () =>
        new Response(payload, { headers: { "Content-Type": "text/event-stream" } });
      const chunks = await readSSE(replay());
      const stitched = stitchChunks(chunks);
      const candidate = stitched.candidates[0];
      const { usageMetadata: usage } = stitched;
      const price = costs(model, usage);
      context.calls.push({
        phase,
        model,
        level,
        finish: candidate?.finishReason,
        ms: performance.now() - start,
        usage,
        cost: price,
        version: chunks.findLast((chunk) => chunk.modelVersion)?.modelVersion,
      });
      if (!stitched.complete || candidate?.finishReason !== "STOP") {
        return Response.json({ error: "benchmark generation did not complete" }, { status: 400 });
      }
      return replay();
    } catch {
      return fail("Provider transport or stream failure");
    }
  };

  const { tailorResume } = await import("../../extension/background/tailor.js");
  const runs = [];
  try {
    for (const [i, fixture] of selected.entries()) {
      const { store, doc } = setup(fixture);
      const offset = i % arms.length;
      // Fix the PDF input across variants using the real layout cache after the first read.
      const ordered = doc ? arms : [...arms.slice(offset), ...arms.slice(0, offset)];
      let layout;
      for (const arm of ordered) {
        assert.ok(!doc || arm === arms[0] || layout, "shared PDF transcription was unavailable");
        const local = {
          "internscout.session": {
            token: "iss_local_fixture",
            expires: new Date(Date.now() + 3_600_000).toISOString(),
          },
        };
        if (layout) local.resume_layout = structuredClone(layout);
        const context = { arm, local, session: {}, calls: [] };
        const run = { case: fixture.id, variant: arm.id, calls: context.calls };
        runs.push(run);
        try {
          const job = {
            company: "Example Internship Group",
            title: fixture.field + " intern",
            description: fixture.job,
            run_id: "benchmark-" + fixture.id,
          };
          const made = await contexts.run(context, () => tailorResume(structuredClone(store), job));
          assert.equal(made.format, fixture.format);
          const bytes = Buffer.from(made.file.b64, "base64");
          if (fixture.format === "docx") {
            await assertDocx(store.files.resume.b64, made.file.b64);
          } else {
            assertPdf(bytes);
            if (doc) {
              const read = local.resume_layout;
              assert.equal(docText(read.doc).toLowerCase(), docText(doc).toLowerCase());
              layout = read;
            }
          }
          run.formatPassed = true;
          run.diff = made.diff;
          run.summary = made.summary;
          const ext = fixture.format === "docx" ? ".docx" : ".pdf";
          await writeFile(new URL(fixture.id + "-" + arm.id + ext, directory), bytes);
        } catch {
          run.formatPassed = false;
        }
        console.log(fixture.id + " · " + arm.id + " · " + (run.formatPassed ? "passed" : "failed"));
      }
    }
  } finally {
    const { reviews, variants } = gradePacket(runs);
    await writeFile(new URL("blind-review.json", directory), JSON.stringify(reviews, null, 2));
    await writeFile(new URL("blind-key.json", directory), JSON.stringify(variants, null, 2));
    await writeFile(
      new URL("results.json", directory),
      JSON.stringify({ planned, attempted, runs, summary: summarize(runs) }, null, 2),
    );
  }
  if (runs.some((run) => !run.formatPassed || run.calls.some((call) => !call.cost)))
    process.exitCode = 1;
}

main().catch(() => {
  console.error("Gemini resume qualification could not complete data collection.");
  process.exitCode = 1;
});
