// Styled PDF rendering: a tailored resume that keeps the look of the student's own.
//
// lib/pdf.js renderResume() draws every resume in one fixed template, which is the wrong answer for
// a student who spent an evening on theirs: serif became Helvetica, their section order and titles
// were replaced with ours, and any section the template had no slot for (Leadership, Awards,
// Activities) was dropped. renderLayout() draws from a description of the original instead
// (lib/resume_doc.js): its font family, sizes, alignment, heading style, bullet glyph, margins, and
// its sections in their own order under their own titles. renderResume() stays as the fallback for
// when no description of the original exists (a .txt resume, or the layout could not be read).
//
// Text is "rich": **bold** and *italic* marks inside any string are drawn as such, because resumes
// mix weights inside one line ("**Languages:** Python, Java") and a per-line style could not say so.
// This file is ASCII only; every other character is written as a \u escape.
import { FONT_WIDTHS } from "./pdf_fonts.js";

const FAMILY = {
  sans: { r: "Helvetica", b: "Helvetica-Bold", i: "Helvetica-Oblique", bi: "Helvetica-BoldOblique" },
  serif: { r: "Times-Roman", b: "Times-Bold", i: "Times-Italic", bi: "Times-BoldItalic" },
};
const FONT_ORDER = ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique", "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic"];
const WIDTHS_OF = { "Helvetica-Oblique": "Helvetica", "Helvetica-BoldOblique": "Helvetica-Bold" };

// Unicode -> WinAnsi (cp1252). Accents survive (pdf.js clean() strips them, so "Jos\u00e9" became
// "Jose"), and so do real dashes, quotes and bullets. Anything WinAnsi has no code for is folded to
// ASCII. HIGH lists the characters cp1252 puts at 0x80..0x9f, in order; "" marks an unused code.
const HIGH = ["\u20ac", "", "\u201a", "\u0192", "\u201e", "\u2026", "\u2020", "\u2021", "\u02c6", "\u2030", "\u0160", "\u2039", "\u0152", "", "\u017d", "",
  "", "\u2018", "\u2019", "\u201c", "\u201d", "\u2022", "\u2013", "\u2014", "\u02dc", "\u2122", "\u0161", "\u203a", "\u0153", "", "\u017e", "\u0178"];
const BULLET = "\u2022";
const FOLD = {
  "\u25aa": BULLET, "\u25a0": BULLET, "\u25cf": BULLET, "\u25e6": BULLET, "\u25cb": BULLET, "\u2023": BULLET, "\u2043": BULLET, "\u2219": BULLET,
  "\u25c6": BULLET, "\u2756": BULLET, "\u27a2": BULLET, "\u25ba": BULLET, "\u25b8": BULLET, "\uf0b7": BULLET, "\u00b7": BULLET,
  "\u2192": "->", "\u2190": "<-", "\u2265": ">=", "\u2264": "<=", "\u2248": "~", "\u2212": "-", "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2015": "\u2014",
  "\u00a0": " ", "\u2009": " ", "\u200a": " ", "\u2002": " ", "\u2003": " ", "\u202f": " ", "\u200b": "", "\ufeff": "", "\t": " ", "\n": " ", "\r": " ",
};
export function encode(s) {
  let out = "";
  for (const c of String(s ?? "")) {
    for (const ch of FOLD[c] != null ? FOLD[c] : c) {
      const k = ch.codePointAt(0);
      if ((k >= 0x20 && k <= 0x7e) || (k >= 0xa0 && k <= 0xff)) { out += ch; continue; }
      const hi = HIGH.indexOf(ch);
      if (hi >= 0) out += String.fromCharCode(0x80 + hi);
      else out += ch.normalize("NFKD").replace(/[^\x20-\x7e]/g, "");
    }
  }
  return out;
}

// Width of an already-encoded string in one of the eight fonts, in points.
export function widthIn(font, s, size) {
  const table = FONT_WIDTHS[WIDTHS_OF[font] || font] || FONT_WIDTHS.Helvetica;
  let w = 0;
  for (let i = 0; i < s.length; i++) w += table[s.charCodeAt(i) - 32] || 500;
  return (w * size) / 1000;
}

// "a **b** *c*" -> [{text, b, i}]. One star toggles italic, two bold, three both. A star that never
// closes only restyles the rest of that one string, which is the cheapest way to be wrong.
export function parseRich(s) {
  const out = [], str = String(s ?? "");
  let b = false, i = false, buf = "";
  const flush = () => { if (buf) out.push({ text: buf, b, i }); buf = ""; };
  for (let k = 0; k < str.length; k++) {
    if (str[k] !== "*") { buf += str[k]; continue; }
    let n = 1;
    while (str[k + n] === "*") n++;
    flush();
    if (n === 1) i = !i; else if (n === 2) b = !b; else { b = !b; i = !i; }
    k += n - 1;
  }
  flush();
  return out;
}
export const plain = (s) => parseRich(s).map((x) => x.text).join("").replace(/\s+/g, " ").trim();

const fontOf = (fam, seg, base) => {
  const b = seg.b || !!base.b, i = seg.i || !!base.i;
  return FAMILY[fam][b && i ? "bi" : b ? "b" : i ? "i" : "r"];
};

// Rich string -> lines [{atoms:[{text, font, w, lead}], w}] no wider than max. A word is never
// split, and a word glued to the one before it ("**GPA:**3.9") stays glued across a font change.
export function wrapRich(s, fam, size, max, base = {}) {
  const words = [];
  let gap = false;
  for (const seg of parseRich(s)) {
    const font = fontOf(fam, seg, base);
    for (const part of encode(seg.text).split(/( +)/)) {
      if (!part) continue;
      if (part[0] === " ") { gap = true; continue; }
      words.push({ text: part, font, w: widthIn(font, part, size), gap });
      gap = false;
    }
  }
  const lines = [];
  let cur = [], w = 0;
  for (const a of words) {
    const sp = widthIn(a.font, " ", size);
    if (cur.length && a.gap && w + sp + a.w > max) { lines.push({ atoms: cur, w }); cur = []; w = 0; }
    const lead = cur.length && a.gap ? sp : 0;
    cur.push({ text: a.text, font: a.font, w: a.w, lead });
    w += lead + a.w;
  }
  if (cur.length) lines.push({ atoms: cur, w });
  return lines;
}

const hexRgb = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || ""));
  if (!m || /^0{6}$/.test(m[1])) return null; // black is the default; say nothing
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => (v / 255).toFixed(3)).join(" ");
};

class StyledDoc {
  constructor(page, mx, my) {
    this.W = page === "a4" ? 595.28 : 612;
    this.H = page === "a4" ? 841.89 : 792;
    this.mx = mx; this.my = my;
    this.pages = [];
    this.newPage();
  }
  newPage() { this.ops = []; this.pages.push(this.ops); this.y = this.H - this.my; }
  ensure(h) { if (this.y - h < this.my) this.newPage(); }
  line(x, y, ln, size, color) {
    // Runs of one font go out as one string; the pen moves by the measured width in between.
    const rgb = hexRgb(color);
    let cx = x, i = 0;
    while (i < ln.atoms.length) {
      const font = ln.atoms[i].font;
      let text = "", w = 0, first = true;
      while (i < ln.atoms.length && ln.atoms[i].font === font) {
        const a = ln.atoms[i];
        if (a.lead) { if (first) cx += a.lead; else { text += " "; w += a.lead; } }
        text += a.text; w += a.w; first = false; i++;
      }
      this.ops.push(`BT ${rgb ? rgb + " rg " : ""}/F${FONT_ORDER.indexOf(font) + 1} ${size.toFixed(2)} Tf ${cx.toFixed(2)} ${y.toFixed(2)} Td (${text.replace(/[\\()]/g, "\\$&")}) Tj ET${rgb ? " 0 g" : ""}`);
      cx += w;
    }
  }
  rule(y, color, weight = 0.6) {
    const rgb = hexRgb(color);
    this.ops.push(`${rgb ? rgb + " RG " : ""}${weight} w ${this.mx.toFixed(2)} ${y.toFixed(2)} m ${(this.W - this.mx).toFixed(2)} ${y.toFixed(2)} l S${rgb ? " 0 G" : ""}`);
  }
  bytes() {
    const objs = ["<< /Type /Catalog /Pages 2 0 R >>", ""];
    for (const f of FONT_ORDER) objs.push(`<< /Type /Font /Subtype /Type1 /BaseFont /${f} /Encoding /WinAnsiEncoding >>`);
    const fonts = FONT_ORDER.map((_, i) => `/F${i + 1} ${i + 3} 0 R`).join(" ");
    const kids = [];
    for (const ops of this.pages) {
      const stream = ops.join("\n");
      objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources << /Font << ${fonts} >> >> /Contents ${objs.length} 0 R >>`);
      kids.push(objs.length);
    }
    objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
    let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
    const offsets = objs.map((o, i) => { const at = out.length; out += `${i + 1} 0 obj\n${o}\nendobj\n`; return at; });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const b = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) b[i] = out.charCodeAt(i) & 255;
    return b;
  }
}

// doc: a normalized resume document (lib/resume_doc.js normalizeLayout). scale shrinks type and
// spacing together, margins a little. Returns {bytes, pages}.
export function renderLayout(doc, scale = 1) {
  const st = doc.style, fam = st.font === "serif" ? "serif" : "sans";
  const d = new StyledDoc(st.page, st.margin_in * 72, Math.max(26, st.margin_top_in * 72 * scale));
  const L = d.mx, R = d.W - d.mx, body = st.body_size * scale, lead = body * st.line_gap;
  const put = (s, size, { align = "left", base = {}, color, lh = size * st.line_gap } = {}) => {
    for (const ln of wrapRich(s, fam, size, R - L, base)) {
      d.ensure(lh); d.y -= lh;
      d.line(align === "center" ? L + (R - L - ln.w) / 2 : align === "right" ? R - ln.w : L, d.y, ln, size, color);
    }
  };

  const h = doc.header;
  if (h.name) put(st.name_caps ? h.name.toUpperCase() : h.name, st.name_size * scale, { align: st.name_align, base: { b: st.name_bold }, color: st.accent, lh: st.name_size * scale * 1.05 });
  if (h.contact.length) d.y -= body * 0.2;
  for (const c of h.contact) put(c, st.contact_size * scale, { align: st.contact_align });

  const glyph = wrapRich(st.bullet, fam, body, 40)[0] || null;
  for (const sec of doc.sections) {
    const hs = st.heading_size * scale;
    d.ensure(hs * st.line_gap + lead * 2 + body); // a heading never sits alone at the foot of a page
    d.y -= body * st.section_gap;
    if (sec.title) {
      if (st.heading.rule === "above") { d.rule(d.y, st.accent); d.y -= 2; }
      put(st.heading.caps ? sec.title.toUpperCase() : sec.title, hs, { align: st.heading.align, base: { b: st.heading.bold }, color: st.accent });
      if (st.heading.rule === "below") { d.y -= hs * 0.3; d.rule(d.y, st.accent); }
      d.y -= body * 0.15;
    }
    for (const ln of sec.lines) put(ln, body);
    sec.entries.forEach((e, n) => {
      if (n || sec.lines.length) d.y -= body * st.entry_gap;
      d.ensure(lead * Math.min(3, e.rows.length + (e.bullets.length ? 1 : 0)));
      for (const row of e.rows) {
        const right = wrapRich(row.right, fam, body, (R - L) * 0.6)[0] || null;
        const left = wrapRich(row.left, fam, body, R - L - (right ? right.w + 10 : 0));
        (left.length ? left : [null]).forEach((ln, k) => {
          d.ensure(lead); d.y -= lead;
          if (ln) d.line(L, d.y, ln, body);
          if (!k && right) d.line(R - right.w, d.y, right, body);
        });
      }
      if (e.text) put(e.text, body);
      for (const b of e.bullets) {
        const bx = L + st.bullet_indent * scale, tx = bx + (glyph ? glyph.w : 0) + body * 0.55;
        wrapRich(b, fam, body, R - tx).forEach((ln, k) => {
          d.ensure(lead); d.y -= lead;
          if (!k && glyph) d.line(bx, d.y, glyph, body);
          d.line(tx, d.y, ln, body);
        });
      }
    });
  }
  return { bytes: d.bytes(), pages: d.pages.length };
}

// A reworded bullet that wraps one line further must not push a one-page resume onto a second page,
// so shrink type and spacing a little at a time until it fits the page count the original had.
export function renderLayoutFit(doc) {
  const want = Math.max(1, doc.style.pages || 1);
  let last = null;
  for (let step = 0; step <= 10; step++) {
    const scale = 1 - step * 0.02;
    last = { ...renderLayout(doc, scale), scale };
    if (last.pages <= want) return last;
  }
  return last;
}
