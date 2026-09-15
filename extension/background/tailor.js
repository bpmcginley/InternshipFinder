// One AI call per job: reword the candidate's existing resume content toward the posting, check it, render a PDF.
import { callAI, jsonOf } from "./claude.js";
import { modelFor } from "../lib/store.js";
import { renderResume, toB64 } from "../lib/pdf.js";
import { applyTailoring, tailorInput } from "../lib/tailoring.js";

const SYSTEM = `You tailor a student's resume to one job posting. You may ONLY:
- reword existing bullets so they use the posting's language, where that stays truthful;
- reorder bullets within a role (most relevant first) and reorder skills;
- leave out at most one clearly irrelevant bullet from a role that has 3 or more;
- write a 1-2 sentence summary that uses only facts in the profile.
Never add employers, titles, dates, tools, technologies, numbers, metrics, awards, coursework or responsibilities that are not already in the profile. Copy every number exactly. Keep bullets under 30 words, starting with a strong verb. Match the candidate's voice. If a bullet already fits, keep its text.

Reply with JSON only:
{"summary": "...",
 "experience": [{"i": <role index>, "bullets": [{"from": <original bullet index j>, "text": "..."}]}],
 "projects": [{"i": <project index>, "description": "..."}],
 "skills": {"technical": [...], "tools": [...], "soft": [...]},
 "changes": ["short note on each meaningful change and why it fits the posting"]}`;

export async function tailorResume(store, job) {
  const resp = await callAI({
    ai: store.ai, model: modelFor(store, "tailor"), kind: "tailor", run_id: job.run_id, max_tokens: 4000, system: SYSTEM,
    messages: [{ role: "user", content: `JOB\n${job.company} - ${job.title}\n${String(job.description).slice(0, 6000)}\n\nPROFILE (JSON)\n${JSON.stringify(tailorInput(store))}` }],
  });
  const out = jsonOf(resp);
  const { resume, diff } = applyTailoring(store, out);
  const bytes = renderResume(resume);
  const f = store.profile.facts;
  const base = [f.first_name, f.last_name].filter(Boolean).join("_").replace(/[^\w-]/g, "") || "Tailored";
  return {
    file: { name: `${base}_Resume.pdf`, type: "application/pdf", size: bytes.length, b64: toB64(bytes) },
    summary: resume.summary,
    changes: (Array.isArray(out.changes) ? out.changes : []).slice(0, 8).map(String),
    diff,
    cost_usd: resp.cost_usd || 0,
    created: Date.now(),
  };
}
