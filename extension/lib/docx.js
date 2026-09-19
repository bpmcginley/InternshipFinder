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

export const docxTailorInput = ({ paras, groups }) =>
  groups.map((g) => ({ g: g.g, under: g.under, bullets: g.items.map((i, j) => ({ j, text: paras[i].text })) }));

// Split a paragraph into the part that belongs to its slot on the page (the opening tag and its
// paragraph properties: indent, spacing, numbering) and the part that is the bullet itself (runs).
function split(px) {
  const open = /^<w:p(?:\s[^>]*)?>/.exec(px)[0];
  const ppr = (/^<w:pPr>[\s\S]*?<\/w:pPr>/.exec(px.slice(open.length)) || [""])[0];
  return { head: open + ppr, runs: px.slice(open.length + ppr.length, px.length - "</w:p>".length) };
}

// Put new words into a bullet's runs. A typed bullet glyph at the front stays where it is; the new
// text goes into the run that held the most of the old text, so it takes the bullet's main
// formatting, and the other text runs are emptied rather than removed.
function setText(runs, next) {
  const ts = [...runs.matchAll(TEXT)].filter((m) => m[0].startsWith("<w:t") && !m[0].startsWith("<w:tab")).map((m) => ({ at: m.index, len: m[0].length, text: decode(m[1] || "") }));
  if (!ts.length) return null;
  const lead = (GLYPH.exec(textOf(runs)) || [""])[0].replace(/\t/g, "");
  let left = lead.length;
  for (const t of ts) { t.keep = t.text.slice(0, Math.min(left, t.text.length)); left -= t.keep.length; t.body = t.text.length - t.keep.length; }
  const carrier = ts.reduce((a, b) => (b.body > a.body ? b : a));
  if (!carrier.body) return null;
  let out = runs;
  for (const t of [...ts].reverse()) {
    const text = t.keep + (t === carrier ? next : "");
    if (text === t.text) continue;
    out = out.slice(0, t.at) + `<w:t xml:space="preserve">${escape(text)}</w:t>` + out.slice(t.at + t.len);
  }
  return out;
}

const tidy = (v) => String(v == null ? "" : v).replace(/\*+/g, "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
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
      let text = tidy(b && b.text);
      if (!text || !fits(text, orig[j].text) || hasNewNumbers(text, orig[j].text)) text = orig[j].text;
      order.push({ j, text });
    }
    const missing = orig.map((_, j) => j).filter((j) => !used.has(j));
    if (missing.length > 1 || orig.length <= 2) for (const j of missing) order.push({ j, text: orig[j].text });
    if (order.every((o, n) => o.j === n && o.text === orig[n].text) && order.length === orig.length) continue;
    // Slots keep their own paragraph properties, so the last bullet keeps the last bullet's spacing
    // even when a bullet above it was dropped.
    const slots = orig.map((_, n) => n);
    if (order.length < slots.length) slots.splice(slots.length - 2, 1);
    let built = "", ok = true;
    order.forEach((o, n) => {
      const src = split(orig[o.j].xml), slot = split(orig[slots[n]].xml);
      const runs = o.text === orig[o.j].text ? src.runs : setText(src.runs, o.text);
      if (runs == null) { ok = false; return; }
      built += slot.head + runs + "</w:p>";
    });
    if (!ok) continue;
    for (const o of order) if (o.text !== orig[o.j].text) diff.push({ where: g.under.split(" / ")[0] || "Resume", before: orig[o.j].text, after: o.text });
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
