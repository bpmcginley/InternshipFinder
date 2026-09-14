// Pure checks for a tailored resume: the model may only reword/reorder what the profile already says.
// Anything that fails a check falls back to the original text.

const nums = (s) => String(s || "").match(/\d+(?:[.,]\d+)*/g) || [];
export const hasNewNumbers = (text, source) => { const ok = new Set(nums(source)); return nums(text).some((n) => !ok.has(n)); };
const bare = (u) => String(u || "").replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, "");

export function canTailor(store, job) {
  const p = store.profile;
  return !!(job.description && job.description.length > 200 &&
    (p.experience.some((e) => (e.bullets || []).length) || p.projects.some((x) => x.description)));
}

// What the model sees: indexed so its answer can be mapped back and checked.
export function tailorInput(store) {
  const p = store.profile;
  return {
    experience: p.experience.map((e, i) => ({ i, company: e.company, title: e.title, bullets: (e.bullets || []).map((text, j) => ({ j, text })) })),
    projects: p.projects.map((x, i) => ({ i, name: x.name, description: x.description })),
    skills: p.skills,
    education: p.education.map(({ school, degree, major, minor }) => ({ school, degree, major, minor })),
    career_goal: p.goals.career,
    voice: p.voice.summary,
  };
}

function reorderList(orig, picked) {
  const byKey = new Map((orig || []).map((s) => [String(s).toLowerCase(), s]));
  const out = [];
  for (const s of Array.isArray(picked) ? picked : []) {
    const hit = byKey.get(String(s).toLowerCase());
    if (hit && !out.includes(hit)) out.push(hit);
  }
  for (const s of orig || []) if (!out.includes(s)) out.push(s);
  return out;
}

// out: {summary, experience:[{i, bullets:[{from, text}]}], projects:[{i, description}], skills:{...}}
export function applyTailoring(store, out) {
  const p = store.profile, f = p.facts, diff = [];
  out = out && typeof out === "object" ? out : {};
  const expBy = new Map((Array.isArray(out.experience) ? out.experience : []).map((e) => [Number(e && e.i), e]));
  const experience = p.experience.map((e, i) => {
    const orig = e.bullets || [], t = expBy.get(i);
    if (!t || !Array.isArray(t.bullets)) return { ...e };
    const used = new Set(), bullets = [];
    for (const b of t.bullets) {
      const j = Number(b && b.from);
      if (!Number.isInteger(j) || j < 0 || j >= orig.length || used.has(j)) continue;
      used.add(j);
      let text = String((b && b.text) || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 400 || hasNewNumbers(text, orig[j])) text = orig[j];
      if (text !== orig[j]) diff.push({ where: e.company || e.title || "", before: orig[j], after: text });
      bullets.push(text);
    }
    // One weak bullet may be dropped from a role with 3+ bullets; anything else missing goes back in.
    const missing = orig.map((_, j) => j).filter((j) => !used.has(j));
    if (missing.length > 1 || orig.length <= 2) for (const j of missing) bullets.push(orig[j]);
    return { ...e, bullets };
  });
  const projBy = new Map((Array.isArray(out.projects) ? out.projects : []).map((x) => [Number(x && x.i), x]));
  const projects = p.projects.map((x, i) => {
    const t = projBy.get(i), text = t && String(t.description || "").replace(/\s+/g, " ").trim();
    if (!text || text.length > 500 || hasNewNumbers(text, x.description) || text === x.description) return { ...x };
    diff.push({ where: x.name || "Project", before: x.description, after: text });
    return { ...x, description: text };
  });
  const sk = out.skills || {};
  const skills = { technical: reorderList(p.skills.technical, sk.technical), tools: reorderList(p.skills.tools, sk.tools), soft: reorderList(p.skills.soft, sk.soft) };
  let summary = String(out.summary || "").replace(/\s+/g, " ").trim();
  if (summary.length > 400 || hasNewNumbers(summary, JSON.stringify(p))) summary = "";

  const name = [f.preferred_name || f.first_name, f.last_name].filter(Boolean).join(" ");
  const contact = [store.settings.signup_email || f.email, f.phone, [f.city, f.state].filter(Boolean).join(", "), bare(f.linkedin), bare(f.github), bare(f.website)];
  return { resume: { name, contact, summary, education: p.education, experience, projects, skills }, diff };
}
