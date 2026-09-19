// Tailor a Word resume in place. A .docx is the one format where "keep my formatting" can be exact:
// the file already holds the fonts, spacing, tabs, tables and numbering the student chose, so the
// only thing that changes is the words inside the bullets that were reworded. Everything else in
// the file, document.xml included, is carried over untouched (lib/zip.js copies other entries raw).
//
// The service worker has no DOMParser, so this works on the XML as text. It is deliberately timid:
// any paragraph with something it does not understand (a drawing, a field, tracked changes, a text
// box) is left alone, and a file with no bullets it can edit makes the caller fall back.
// This file is ASCII only; every other character is written as a \u escape.
import { hasNewNumbers } from "./tailoring.js";
import { reorderSkills } from "./resume_doc.js";
import { entryBytes, readZip, withContent, writeZip } from "./zip.js";

export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAIN = "word/document.xml";

export function fromB64(b64) {
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, k) => {
  if (k[0] !== "#") return ENT[k.toLowerCase()];
  const n = k[1] === "x" || k[1] === "X" ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
  return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
});
const escape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const PARA = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
const TEXT = /<w:t(?:\s[^>]*)?\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br(?:\s[^>]*)?\/>/g;
const GLYPH = /^\s*[\u2022\u25aa\u25a0\u25cf\u25e6\u25cb\u2023\u2043\u2219\u25c6\u2756\u27a2\u25ba\u25b8\u00b7\uf0b7\uf0a7\u2013\u2014*-][ \t\u00a0]+/;
const OPAQUE = /<w:drawing|<w:pict|<w:fldChar|<w:fldSimple|<w:ins[ >]|<w:del[ >]|<w:object|<mc:AlternateContent|<w:sdt[ >]/;

const textOf = (xml) => {
  let out = "";
  for (const m of xml.matchAll(TEXT)) out += m[0].startsWith("<w:tab") ? "\t" : m[0].startsWith("<w:br") ? " " : decode(m[1] || "");
  return out;
};

// ---------- the look of each word ----------
// A bullet is rarely one run. "Backend: built a REST API" is a bold run and a plain one; a paper's
// title is an italic run in the middle; a repository is a run inside <w:hyperlink>; a date sits after
// a <w:tab/>. The first version poured the whole reworded bullet into the longest run and emptied the
// rest, and the review showed what that did: the bold lead-in went plain, a whole bullet went italic,
// the link died, the date came off its tab stop. pieces() reads a paragraph's runs as the pieces of
// text they are, each with its "look": the run properties that show on the page, and the hyperlink
// it sits in if any. Proofing language, no-spell-check flags, font hints and revision ids are left out
// of the look, because Word splits runs on them without anything changing on the page.
const RUN = /<w:r(?:\s[^>]*)?>[\s\S]*?<\/w:r>/g;
const LINK = /<w:hyperlink(?:\s[^>]*)?>[\s\S]*?<\/w:hyperlink>/g;
const lookOf = (rpr) => rpr.replace(/<w:(?:lang|noProof)\b[^>]*\/>/g, "").replace(/\s+w:hint="[^"]*"/g, "").replace(/\s+w:rsid\w*="[^"]*"/g, "").replace(/<w:rPr>\s*<\/w:rPr>|<w:rPr\/>/g, "");

function pieces(runs) {
  const links = [...runs.matchAll(LINK)].map((m) => [m.index, m.index + m[0].length]);
  const out = [];
  let o = 0;
  for (const r of runs.matchAll(RUN)) {
    const rpr = (/<w:rPr>[\s\S]*?<\/w:rPr>|<w:rPr\/>/.exec(r[0]) || [""])[0];
    const link = links.findIndex(([a, b]) => r.index >= a && r.index < b);
    const look = lookOf(rpr) + (link >= 0 ? `|link${link}` : "");
    for (const m of r[0].matchAll(TEXT)) {
      const kind = m[0].startsWith("<w:tab") ? "tab" : m[0].startsWith("<w:br") ? "br" : "t";
      const text = kind === "tab" ? "\t" : kind === "br" ? " " : decode(m[1] || "");
      out.push({ kind, at: r.index + m.index, len: m[0].length, text, look, o });
      o += text.length;
    }
  }
  return out;
}

// The bullet as bulletGroups() shows it to the model (glyph off, whitespace collapsed, trimmed), and
// for each of its characters where in the paragraph's raw text it came from.
function bodyOf(ps) {
  const raw = ps.map((p) => p.text).join("");
  const lead = (GLYPH.exec(raw) || [""])[0].length;
  const from = [];
  let body = "";
  for (let i = lead; i < raw.length; i++) {
    const ws = /\s/.test(raw[i]);
    if (ws && (!body || body.endsWith(" "))) continue;
    body += ws ? " " : raw[i];
    from.push(i);
  }
  if (body.endsWith(" ")) { body = body.slice(0, -1); from.pop(); }
  return { raw, lead, body, from };
}

// The look most of the bullet's words have. Words typed in between take it.
function mainLook(ps, lead) {
  const n = new Map();
  for (const p of ps) if (p.kind === "t" && p.o + p.text.length > lead) n.set(p.look, (n.get(p.look) || 0) + p.text.length - Math.max(0, lead - p.o));
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k)[0];
}

// The words of a bullet that look different from the rest of it, plus whatever sits after a tab.
// The model is told to leave them where they are (see SYSTEM_DOCX); setText() enforces it either way.
function fixedWords(px) {
  const ps = pieces(split(px).runs), { lead, raw } = bodyOf(ps), main = mainLook(ps, lead);
  const out = [];
  let cur = "", look = null;
  const flush = () => { const t = cur.replace(/\s+/g, " ").trim(); if (t) out.push(t.slice(0, 80)); cur = ""; };
  for (const p of ps) {
    if (p.o + p.text.length <= lead) continue;
    if (p.kind !== "t" || p.look === main) { flush(); look = null; continue; }
    if (look !== null && p.look !== look) flush();
    look = p.look;
    cur += p.o < lead ? p.text.slice(lead - p.o) : p.text;
  }
  flush();
  const tab = raw.lastIndexOf("\t");
  if (tab >= lead && raw.slice(tab + 1).trim()) out.push(raw.slice(tab + 1).replace(/\s+/g, " ").trim().slice(0, 80));
  return [...new Set(out)].slice(0, 5);
}

// Where a bullet sits in its list: level, list, indent and style. Bullets at different levels do not
// trade places (see applyDocxTailoring).
const levelOf = (px) => {
  const ppr = (/<w:pPr>[\s\S]*?<\/w:pPr>/.exec(px) || [""])[0];
  return ["ilvl", "numId", "pStyle", "ind"].map((k) => (new RegExp(`<w:${k}\\b[^>]*/>`).exec(ppr) || [""])[0].replace(/\s+w:rsid\w*="[^"]*"/g, "")).join("|");
};

function isBullet(xml, text) {
  const ppr = (/<w:pPr>[\s\S]*?<\/w:pPr>/.exec(xml) || [""])[0];
  if (/<w:numPr>/.test(ppr) && !/<w:numId w:val="0"\s*\/>/.test(ppr)) return true;
  if (/<w:pStyle w:val="[^"]*(?:bullet|list(?!\s?paragraph))[^"]*"/i.test(ppr)) return true;
  return GLYPH.test(text);
}

// xml -> {paras, groups}. A group is a run of bullets with nothing between them, which is what one
// role's bullets are; "under" is the one or two lines above it (employer, title, dates) as context.
export function bulletGroups(xml) {
  const boxes = [];
  for (const m of xml.matchAll(/<w:txbxContent>[\s\S]*?<\/w:txbxContent>/g)) boxes.push([m.index, m.index + m[0].length]);
  const paras = [];
  for (const m of xml.matchAll(PARA)) {
    const px = m[0], start = m.index, end = start + px.length, text = textOf(px);
    const nested = /<w:p[ >]/.test(px.slice(4)) || boxes.some(([a, b]) => start >= a && end <= b);
    const bullet = isBullet(px, text), body = text.replace(GLYPH, "").replace(/\s+/g, " ").trim();
    paras.push({ start, end, xml: px, text: body, bullet, editable: bullet && !nested && !OPAQUE.test(px) && body.length >= 8 });
  }
  const groups = [];
  let cur = null;
  paras.forEach((p, i) => {
    const joined = cur && !xml.slice(paras[i - 1].end, p.start).trim();
    if (p.editable && joined) { cur.items.push(i); return; }
    cur = null;
    if (!p.editable) return;
    const under = [];
    for (let k = i - 1; k >= 0 && under.length < 2 && !paras[k].bullet; k--) if (paras[k].text) under.unshift(paras[k].text.slice(0, 160));
    cur = { g: groups.length, under: under.join(" / "), items: [i] };
    groups.push(cur);
  });
  return { paras, groups };
}

// was: bullets: g.items.map((i, j) => ({ j, text: paras[i].text }))
// "keep" is added for a bullet whose words do not all look alike: the bold lead-in, the italic title,
// the link, the date after a tab. It is left off every other bullet, which is most of them.
export const docxTailorInput = ({ paras, groups }) =>
  groups.map((g) => ({ g: g.g, under: g.under, bullets: g.items.map((i, j) => {
    const keep = fixedWords(paras[i].xml);
    return keep.length ? { j, text: paras[i].text, keep } : { j, text: paras[i].text };
  }) }));

// Split a paragraph into the part that belongs to its slot on the page (the opening tag and its
// paragraph properties: indent, spacing, numbering) and the part that is the bullet itself (runs).
function split(px) {
  const open = /^<w:p(?:\s[^>]*)?>/.exec(px)[0];
  const ppr = (/^<w:pPr>[\s\S]*?<\/w:pPr>/.exec(px.slice(open.length)) || [""])[0];
  return { head: open + ppr, runs: px.slice(open.length + ppr.length, px.length - "</w:p>".length) };
}

// Put new words into a bullet's runs, touching only the words that changed.
//
// was: the new text went whole into the run that held the most of the old text and every other text
// run was emptied. That is right for a bullet that is one run and wrong for every other bullet (see
// pieces() above). Now the old and new text are lined up from both ends, and only the stretch in the
// middle that differs is rewritten, inside the run or runs it already sat in. Everything before and
// after it - the glyph, a bold lead-in, a link, a tab and the date after it - is not touched at all.
// If the changed stretch crosses from one look into another, or over a tab or a line break, there is
// no honest way to say what the new words should look like, and this returns null: the caller keeps
// the student's own wording for that bullet. A kept bullet is a smaller loss than a broken one.
function setText(runs, next) {
  const ps = pieces(runs), { lead, body, from } = bodyOf(ps);
  if (!body || !ps.length) return null;
  let p = 0, s = 0;
  const max = Math.min(body.length, next.length);
  while (p < max && body[p] === next[p]) p++;
  while (s < max - p && body[body.length - 1 - s] === next[next.length - 1 - s]) s++;
  const a = p < body.length ? from[p] : from[body.length - 1] + 1;        // raw [a, b) is what changes
  const b = body.length - s > p ? from[body.length - s - 1] + 1 : a;
  const insert = next.slice(p, next.length - s);
  const at = (i) => ps.find((x) => x.o <= i && i < x.o + x.text.length);
  let hit;
  if (a < b) {
    hit = ps.filter((x) => x.o < b && x.o + x.text.length > a);
    if (hit.some((x) => x.kind !== "t" || x.look !== hit[0].look)) return null;
  } else {
    // Words typed in between two pieces: they take the side that looks like the rest of the bullet.
    const before = a - 1 >= lead ? at(a - 1) : null, after = at(a) || null;
    const ok = [before, after].filter((x) => x && x.kind === "t");
    if (!ok.length) return null;
    const main = mainLook(ps, lead);
    hit = [ok.find((x) => x.look === main) || ok[ok.length - 1]];
  }
  const first = hit[0], last = hit[hit.length - 1];
  const cut = a < b ? a : first === at(a) ? a : first.o + first.text.length;   // where in `first` the new words go
  const text = new Map(hit.map((x) => [x, ""]));
  text.set(first, first.text.slice(0, cut - first.o) + insert + (first === last ? first.text.slice(Math.max(b, cut) - first.o) : ""));
  if (first !== last) text.set(last, last.text.slice(b - last.o));
  let out = runs;
  for (const x of [...hit].reverse()) {
    if (text.get(x) === x.text) continue;
    out = out.slice(0, x.at) + `<w:t xml:space="preserve">${escape(text.get(x))}</w:t>` + out.slice(x.at + x.len);
  }
  return out;
}

// was: const tidy = (v) => String(v == null ? "" : v).replace(/\*+/g, "")...
// The stars are stripped because a model likes to reply in **markdown**, but "Implemented A* search"
// has a star of its own, and a bullet the model only moved came back as "Implemented A search".
const tidy = (v, orig = "") => (orig.includes("*") ? String(v == null ? "" : v) : String(v == null ? "" : v).replace(/\*+/g, "")).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
// "Languages: Python, Java, C++": a label and a list of short items, or just the list. The prompt says
// such a line may only be reordered; nothing checked it, and the review got Go, Rust, Kubernetes and
// AWS written into a resume that had none of them. The PDF path already had the check; it is shared.
const listLike = (t) => {
  const m = /^[^:]{2,40}:\s*(.+)$/.exec(t);
  const items = (m ? m[1] : t).split(/\s*(?:\||;|,|\u2022|\u00b7)\s*/).filter(Boolean);
  return items.length >= 3 && items.every((x) => x.split(/\s+/).length <= 4);
};
// Word cannot shrink to fit, so a reworded bullet has to stay close to the length it replaces.
const fits = (next, orig) => next.length <= Math.min(400, orig.length * 1.15 + 10);

// out: {groups:[{g, bullets:[{from, text}]}]} -> {xml, diff}. Same rules as the other two paths.
export function applyDocxTailoring(xml, { paras, groups }, out) {
  const by = new Map((Array.isArray(out && out.groups) ? out.groups : []).map((x) => [Number(x && x.g), x]));
  const diff = [], edits = [];
  for (const g of groups) {
    const t = by.get(g.g);
    if (!t || !Array.isArray(t.bullets)) continue;
    const orig = g.items.map((i) => paras[i]);
    const used = new Set(), order = [];
    for (const b of t.bullets) {
      const j = Number(b && b.from);
      if (!Number.isInteger(j) || j < 0 || j >= orig.length || used.has(j)) continue;
      used.add(j);
      let text = tidy(b && b.text, orig[j].text);
      if (text && listLike(orig[j].text)) text = reorderSkills(orig[j].text, text);      // same items, new order, or nothing
      if (!text || !fits(text, orig[j].text) || hasNewNumbers(text, orig[j].text)) text = orig[j].text;
      order.push({ j, text });
    }
    const missing = orig.map((_, j) => j).filter((j) => !used.has(j));
    // A group that mixes list levels (a bullet and its sub-bullets) keeps its order and all of its
    // bullets. The slot rule below gives a moved bullet the indent of the place it lands in, which
    // is right between equals and turns a parent into a sub-bullet otherwise.
    const mixed = new Set(orig.map((o) => levelOf(o.xml))).size > 1;
    // was: if (missing.length > 1 || orig.length <= 2) ...
    const dropped = missing.length > 1 || orig.length <= 2 || mixed ? [] : missing;
    if (!dropped.length) for (const j of missing) order.push({ j, text: orig[j].text });
    if (mixed) order.sort((x, y) => x.j - y.j);
    // Words that cannot be placed without breaking the bullet's formatting are not used (setText).
    for (const o of order) {
      o.runs = o.text === orig[o.j].text ? split(orig[o.j].xml).runs : setText(split(orig[o.j].xml).runs, o.text);
      if (o.runs == null) { o.text = orig[o.j].text; o.runs = split(orig[o.j].xml).runs; }
    }
    if (order.every((o, n) => o.j === n && o.text === orig[n].text) && order.length === orig.length) continue;
    // Slots keep their own paragraph properties, so the last bullet keeps the last bullet's spacing
    // even when a bullet above it was dropped.
    const slots = orig.map((_, n) => n);
    if (order.length < slots.length) slots.splice(slots.length - 2, 1);
    // was: setText() ran here, and one bullet it could not write threw away the whole group's edit,
    // reordering included. It runs above now and costs only that bullet's rewording.
    let built = "";
    order.forEach((o, n) => { built += split(orig[slots[n]].xml).head + o.runs + "</w:p>"; });
    const where = g.under.split(" / ")[0] || "Resume";
    for (const o of order) if (o.text !== orig[o.j].text) diff.push({ where, before: orig[o.j].text, after: o.text });
    // A bullet that was left out is a change too; the review list showed nothing for it.
    for (const j of dropped) diff.push({ where, before: orig[j].text, after: "(left out)", dropped: true });
    // So is a new order: a resume whose only edit was the order of its bullets said "0 changes".
    if (order.some((o, n) => n && o.j < order[n - 1].j)) diff.push({ where, before: "(bullet order)", after: "Bullets reordered, most relevant first", moved: true });
    edits.push({ start: orig[0].start, end: orig[orig.length - 1].end, xml: built });
  }
  let next = xml;
  for (const e of edits.sort((a, b) => b.start - a.start)) next = next.slice(0, e.start) + e.xml + next.slice(e.end);
  return { xml: next, diff, touched: edits.length };
}

export async function openDocx(b64) {
  const entries = readZip(fromB64(b64));
  const idx = entries.findIndex((e) => e.name === MAIN);
  if (idx < 0) throw new Error("not a Word document");
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(await entryBytes(entries[idx]));
  if (!/<w:document[ >]/.test(xml)) throw new Error("unreadable Word document");
  return { entries, idx, xml };
}

export async function saveDocx({ entries, idx }, xml) {
  const next = entries.slice();
  next[idx] = await withContent(entries[idx], new TextEncoder().encode(xml));
  return writeZip(next);
}
