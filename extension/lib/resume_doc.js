// The "resume document": a description of the student's own resume, section by section in their
// order, with the look it had (font family, sizes, alignment, heading style, bullet glyph, margins).
// lib/pdf_layout.js draws it. It exists so a tailored resume looks like the one the student wrote,
// and keeps every section they had, instead of being poured into our one template (lib/pdf.js).
//
// Everything here is pure and checked the same way lib/tailoring.js checks the profile path: the
// model may only reword and reorder what is already on the page. Employer, title, date and school
// rows are never editable. Anything that fails a check falls back to the original text.
// This file is ASCII only; every other character is written as a \u escape.
import { hasNewNumbers } from "./tailoring.js";
import { plain } from "./pdf_layout.js";

const str = (v, max) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const num = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
const pick = (v, list, dflt) => (list.includes(v) ? v : dflt);
const bool = (v, dflt) => (typeof v === "boolean" ? v : dflt);
const arr = (v) => (Array.isArray(v) ? v : []);

// Model JSON -> a document the renderer can trust: every size clamped, every list capped, every
// string flattened. Returns null when there is not enough of a resume in it to be worth drawing.
export function normalizeLayout(raw) {
  if (!raw || typeof raw !== "object") return null;
  const s = raw.style && typeof raw.style === "object" ? raw.style : {};
  const h = s.heading && typeof s.heading === "object" ? s.heading : {};
  const body = num(s.body_size, 8, 12, 10.5), margin = num(s.margin_in, 0.3, 1.25, 0.6);
  const style = {
    font: pick(s.font, ["serif", "sans"], "sans"),
    body_size: body,
    name_size: num(s.name_size, 12, 30, 18),
    heading_size: num(s.heading_size, 9, 16, Math.min(16, body + 1)),
    contact_size: num(s.contact_size, 7.5, 12, body - 0.5),
    name_align: pick(s.name_align, ["left", "center", "right"], "center"),
    contact_align: pick(s.contact_align, ["left", "center", "right"], pick(s.name_align, ["left", "center", "right"], "center")),
    name_bold: bool(s.name_bold, true),
    name_caps: bool(s.name_caps, false),
    heading: { caps: bool(h.caps, true), bold: bool(h.bold, true), rule: pick(h.rule, ["below", "above", "none"], "below"), align: pick(h.align, ["left", "center"], "left") },
    bullet: str(s.bullet == null ? "\u2022" : s.bullet, 2),
    bullet_indent: num(s.bullet_indent, 0, 30, 10),
    margin_in: margin,
    margin_top_in: num(s.margin_top_in, 0.3, 1.25, margin),
    line_gap: num(s.line_gap, 1.0, 1.6, 1.2),
    section_gap: num(s.section_gap, 0.2, 1.5, 0.7),
    entry_gap: num(s.entry_gap, 0, 1, 0.35),
    accent: /^#?[0-9a-f]{6}$/i.test(String(s.accent || "")) ? String(s.accent) : "",
    page: pick(s.page, ["letter", "a4"], "letter"),
    pages: Math.round(num(s.pages, 1, 3, 1)),
  };
  const hd = raw.header && typeof raw.header === "object" ? raw.header : {};
  const header = { name: str(hd.name, 80), contact: arr(hd.contact).map((c) => str(c, 300)).filter(Boolean).slice(0, 4) };
  const sections = arr(raw.sections).slice(0, 14).map((sec) => ({
    title: str(sec && sec.title, 60),
    lines: arr(sec && sec.lines).map((l) => str(l, 600)).filter(Boolean).slice(0, 30),
    entries: arr(sec && sec.entries).slice(0, 30).map((e) => ({
      rows: arr(e && e.rows).slice(0, 4).map((r) => ({ left: str(r && r.left, 200), right: str(r && r.right, 120) })).filter((r) => r.left || r.right),
      text: str(e && e.text, 1200),
      bullets: arr(e && e.bullets).map((b) => str(b, 600)).filter(Boolean).slice(0, 15),
    })).filter((e) => e.rows.length || e.text || e.bullets.length),
  })).filter((sec) => sec.lines.length || sec.entries.length);
  const body_items = sections.reduce((n, sec) => n + sec.lines.length + sec.entries.reduce((m, e) => m + e.bullets.length + (e.text ? 1 : 0), 0), 0);
  if (!header.name || sections.length < 2 || body_items < 3) return null;
  return { style, header, sections };
}

// All the words on the page, for the checks below and for "did the layout read the right file".
export function docText(doc) {
  const out = [doc.header.name, ...doc.header.contact];
  for (const sec of doc.sections) {
    out.push(sec.title, ...sec.lines);
    for (const e of sec.entries) { for (const r of e.rows) out.push(r.left, r.right); out.push(e.text, ...e.bullets); }
  }
  return out.map(plain).filter(Boolean).join("\n");
}

// The layout comes from a model reading a PDF, so check it against what the student told us before
// trusting it: their name is on it, and most of the employers and schools in their profile are too.
// A miss means the wrong file, a scan the model could not read, or a made-up page; the caller then
// uses the profile-based template instead.
export function layoutMatchesProfile(doc, store) {
  const text = docText(doc).toLowerCase(), p = store.profile, f = p.facts;
  const last = String(f.last_name || "").trim().toLowerCase();
  if (last && !plain(doc.header.name).toLowerCase().includes(last)) return false;
  const key = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\b(inc|llc|corp|co|the|university|college|of|at)\b/g, " ").replace(/\s+/g, " ").trim();
  const flat = key(text);
  const names = [...p.experience.map((e) => e.company), ...p.education.map((e) => e.school)].map(key).filter((k) => k.length >= 3);
  if (!names.length) return true;
  const hits = names.filter((k) => flat.includes(k) || k.split(" ").filter((w) => w.length > 3).some((w) => flat.includes(w))).length;
  return hits * 2 >= names.length;
}

const SKILLS_RE = /skill|technolog|languages|tools|proficien|competenc|software/i;
const SUMMARY_RE = /summary|objective|profile|about/i;
const kindOf = (title) => (SUMMARY_RE.test(title) ? "summary" : SKILLS_RE.test(title) ? "skills" : "other");

// What the model sees: indexed so its answer can be mapped back and checked. Rows go along as
// read-only context ("under"), so it knows which role a bullet belongs to.
export function docTailorInput(doc) {
  return doc.sections.map((sec, s) => ({
    s, title: sec.title, kind: kindOf(sec.title),
    lines: sec.lines.map((text, k) => ({ k, text })),
    entries: sec.entries.map((e, i) => ({
      e: i, under: e.rows.map((r) => [plain(r.left), plain(r.right)].filter(Boolean).join(" | ")).join(" / "),
      ...(e.text ? { text: e.text } : {}),
      bullets: e.bullets.map((text, j) => ({ j, text })),
    })),
  }));
}

// A reworded string keeps bold/italic marks only if the original had some and the new ones pair up.
function marks(next, orig) {
  if (!orig.includes("*")) return next.replace(/\*+/g, "");
  const runs = next.match(/\*+/g) || [];
  const ok = runs.length % 2 === 0 && runs.every((r, i) => (i % 2 ? r === runs[i - 1] : true));
  return ok ? next : next.replace(/\*+/g, "");
}
const tidy = (v) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
// The page was laid out around the original lengths; a bullet that grows a lot reflows the page.
const fits = (next, orig) => plain(next).length <= Math.min(400, plain(orig).length * 1.25 + 15);

// "**Languages:** Python, Java, C++" reordered to the model's order, and nothing else: same label,
// same items (the student's own strings), same separator. Returns the original if anything differs.
function reorderSkills(orig, next) {
  const m = /^(.*?:\**\s*)(.+)$/.exec(orig);
  const label = m ? m[1] : "", list = m ? m[2] : orig;
  const sep = [" | ", "; ", ", ", " \u2022 ", " \u00b7 "].find((x) => list.includes(x));
  if (!sep) return orig;
  const items = list.split(sep).map((x) => x.trim()).filter(Boolean);
  if (items.length < 2) return orig;
  const key = (x) => plain(x).toLowerCase().replace(/[.,;]+$/, "");
  const byKey = new Map(items.map((x) => [key(x), x]));
  const nm = /^(.*?:\**\s*)(.+)$/.exec(next);
  const out = [];
  for (const x of (nm ? nm[2] : next).split(new RegExp("\\s*(?:\\||;|,|\u2022|\u00b7)\\s*"))) {
    const hit = byKey.get(key(x));
    if (hit && !out.includes(hit)) out.push(hit);
  }
  for (const x of items) if (!out.includes(x)) out.push(x);
  // A trailing "and"/period glued to the last item moves with it; leave such lists alone.
  if (/\band\b/i.test(items[items.length - 1]) && out[out.length - 1] !== items[items.length - 1]) return orig;
  return label + out.join(sep);
}

// out: {entries:[{s, e, text, bullets:[{from, text}]}], lines:[{s, k, text}]}
export function applyDocTailoring(doc, out) {
  out = out && typeof out === "object" ? out : {};
  const diff = [], all = docText(doc);
  const entryBy = new Map(arr(out.entries).map((x) => [`${Number(x && x.s)}.${Number(x && x.e)}`, x]));
  const lineBy = new Map(arr(out.lines).map((x) => [`${Number(x && x.s)}.${Number(x && x.k)}`, x]));
  const sections = doc.sections.map((sec, s) => {
    const kind = kindOf(sec.title);
    const lines = sec.lines.map((orig, k) => {
      const t = lineBy.get(`${s}.${k}`);
      let next = t ? tidy(t.text) : "";
      if (!next || kind === "other") return orig;
      if (kind === "skills") next = reorderSkills(orig, next);
      else { next = marks(next, orig); if (!fits(next, orig) || hasNewNumbers(plain(next), all)) return orig; }
      if (plain(next) !== plain(orig)) diff.push({ where: sec.title, before: plain(orig), after: plain(next) });
      return plain(next) === plain(orig) ? orig : next;
    });
    const entries = sec.entries.map((e, i) => {
      const t = entryBy.get(`${s}.${i}`);
      if (!t || kind === "skills") return e;
      const where = plain((e.rows[0] && e.rows[0].left) || sec.title);
      let text = e.text;
      const nt = marks(tidy(t.text), e.text);
      if (e.text && nt && plain(nt) !== plain(e.text) && fits(nt, e.text) && !hasNewNumbers(plain(nt), plain(e.text))) {
        diff.push({ where, before: plain(e.text), after: plain(nt) });
        text = nt;
      }
      if (!Array.isArray(t.bullets) || !e.bullets.length) return { ...e, text };
      const used = new Set(), bullets = [];
      for (const b of t.bullets) {
        const j = Number(b && b.from);
        if (!Number.isInteger(j) || j < 0 || j >= e.bullets.length || used.has(j)) continue;
        used.add(j);
        const orig = e.bullets[j];
        let next = marks(tidy(b && b.text), orig);
        if (!next || !fits(next, orig) || hasNewNumbers(plain(next), plain(orig)) || plain(next) === plain(orig)) next = orig;
        if (next !== orig) diff.push({ where, before: plain(orig), after: plain(next) });
        bullets.push(next);
      }
      // One weak bullet may be dropped from an entry with 3+; anything else missing goes back in.
      const missing = e.bullets.map((_, j) => j).filter((j) => !used.has(j));
      if (missing.length > 1 || e.bullets.length <= 2) for (const j of missing) bullets.push(e.bullets[j]);
      return { ...e, text, bullets };
    });
    return { ...sec, lines, entries };
  });
  return { doc: { ...doc, sections }, diff };
}
