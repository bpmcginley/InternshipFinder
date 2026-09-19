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
// Letters Unicode gives no accent-free spelling for, so the NFKD fold below dropped them whole:
// "\u0141ukasz" was drawn as "ukasz". Folding them is still a change to somebody's name, which is why
// lossless() below does not count these (or any NFKD fold) as faithful.
const LETTERS = { "\u0141": "L", "\u0142": "l", "\u0110": "D", "\u0111": "d", "\u0131": "i", "\u0126": "H", "\u0127": "h", "\u0166": "T", "\u0167": "t", "\u014a": "N", "\u014b": "n" };
// True when every character can be drawn as itself: it is in WinAnsi, or it is one of the
// typographic folds above (a bullet shape, an arrow, a kind of space). Chinese, Cyrillic, Greek and
// Polish or Turkish accents are not, and the review showed them vanishing or changing without a
// word. The caller (background/tailor.js) does not rebuild such a resume; the original is kept.
export function lossless(s) {
  for (const c of String(s ?? "")) {
    if (FOLD[c] != null) continue;
    const k = c.codePointAt(0);
    if ((k >= 0x20 && k <= 0x7e) || (k >= 0xa0 && k <= 0xff) || HIGH.includes(c)) continue;
    return false;
  }
  return true;
}
export function encode(s) {
  let out = "";
  for (const c of String(s ?? "")) {
    // was: for (const ch of FOLD[c] != null ? FOLD[c] : c) {
    for (const ch of FOLD[c] != null ? FOLD[c] : LETTERS[c] != null ? LETTERS[c] : c) {
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
//
// was: every star toggled a style, so "Implemented A* search in C" lost its star and went italic from
// there on. A run of stars now opens a style only when it looks like a mark: text follows it directly,
// a run of the same length closes it later, and a single star does not sit in the middle of a word
// ("2*3"). Anything else is a star the student typed, and is drawn.
export function parseRich(s) {
  const out = [], str = String(s ?? "");
  let b = false, i = false, buf = "";
  const open = { 1: false, 2: false, 3: false };
  const flush = () => { if (buf) out.push({ text: buf, b, i }); buf = ""; };
  const closes = (from, n) => new RegExp("(^|[^*])(?:[*]{" + n + "}|[*]{3})(?![*])").test(str.slice(from));
  for (let k = 0; k < str.length; k++) {
    if (str[k] !== "*") { buf += str[k]; continue; }
    let n = 1;
    while (str[k + n] === "*") n++;
    if (n === 3 && !open[3] && open[1] && open[2]) { flush(); open[1] = open[2] = false; b = false; i = false; k += 2; continue; }   // "**a *b***"
    const after = str[k + n] || "", before = str[k - 1] || "";
    const mark = n <= 3 && (open[n] || (after && !/\s/.test(after) && !(n === 1 && /[A-Za-z0-9]/.test(before)) && closes(k + n, n)));
    if (!mark) { buf += str.slice(k, k + n); k += n - 1; continue; }
    flush();
    open[n] = !open[n];
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
  // was: newPage() { this.ops = []; this.pages.push(this.ops); this.y = this.H - this.my; }
  newPage() { this.ops = []; this.pages.push(this.ops); this.links = []; (this.linksBy = this.linksBy || []).push(this.links); this.y = this.H - this.my; }
  ensure(h) { if (this.y - h < this.my) this.newPage(); }
  // The rebuilt PDF had no links at all: a recruiter could not click the student's email, LinkedIn or
  // GitHub. A printed address is a link again: an email or an http(s) address anywhere, a bare domain
  // ("janedoe.dev", "linkedin.com/in/jane") only on the contact lines, where "ASP.NET" and
  // "Socket.io" are not. A word such as "LinkedIn" is linked when the original file carried a link to
  // that site (this.uris, read from the student's PDF by background/tailor.js).
  linkOf(text, bare) {
    const t = text.replace(/^[(\[<|]+|[)\]>|,;.]+$/g, "");
    if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(t)) return "mailto:" + t;
    if (/^https?:\/\/[^\s]+$/i.test(t)) return t;
    if (bare && /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.(com|dev|io|me|org|net|edu|app|ai|co|tech|xyz|page|site)(\/[^\s]*)?$/i.test(t)) return "https://" + t;
    const k = t.toLowerCase().replace(/[^a-z0-9]/g, "");
    return (k.length >= 4 && (this.uris || []).find((u) => siteOf(u) === k)) || null;
  }
  line(x, y, ln, size, color, bare = false) {
    let px = x;
    for (const a of ln.atoms) {
      px += a.lead || 0;
      const uri = this.linkOf(a.text, bare);
      if (uri) { this.links.push({ rect: [px, y - size * 0.22, px + a.w, y + size * 0.78], uri }); (this.linked = this.linked || []).push(uri); }
      px += a.w;
    }
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
    this.pages.forEach((ops, p) => {
      const stream = ops.join("\n");
      objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      const contents = objs.length, annots = [];
      for (const l of (this.linksBy && this.linksBy[p]) || []) {
        const uri = l.uri.replace(/[^\x20-\x7e]/g, "").replace(/[\\()]/g, "\\$&");
        objs.push(`<< /Type /Annot /Subtype /Link /Rect [${l.rect.map((v) => v.toFixed(2)).join(" ")}] /Border [0 0 0] /A << /S /URI /URI (${uri}) >> >>`);
        annots.push(objs.length);
      }
      // was: ... /Contents ${objs.length} 0 R >>  (no /Annots)
      objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.W} ${this.H}] /Resources << /Font << ${fonts} >> >> /Contents ${contents} 0 R${annots.length ? ` /Annots [${annots.map((n) => `${n} 0 R`).join(" ")}]` : ""} >>`);
      kids.push(objs.length);
    });
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

// The link addresses inside a PDF, from its bytes as base64. A resume that prints "LinkedIn" and
// hides the address behind it keeps that address only here. This reads link annotations stored as
// plain objects, which is how Word, Google Docs and most resume builders write them; a PDF that packs
// its objects into compressed streams (LaTeX does) gives none, and its hidden links cannot be carried
// over. background/tailor.js tells the student when that happens.
export function urisIn(b64) {
  let bin = "";
  try { bin = atob(String(b64 || "")); } catch { return []; }
  const found = [];
  for (const m of bin.matchAll(/\/URI\s*\(((?:[^\\()]|\\[\s\S])*)\)/g)) {
    const u = m[1].replace(/\\([\s\S])/g, "$1");
    if (/^(https?:\/\/|mailto:)[\x21-\x7e]+$/i.test(u) && u.length <= 300 && !found.includes(u)) found.push(u);
  }
  return found.slice(0, 12);
}
// Two spellings of one address: "https://www.linkedin.com/in/jane/" and "linkedin.com/in/jane".
export const sameLink = (a, b) => {
  const n = (u) => String(u).toLowerCase().replace(/^(https?:\/\/|mailto:)/, "").replace(/^www\./, "").replace(/\/+$/, "");
  return n(a) === n(b);
};

// "https://www.linkedin.com/in/jane" -> "linkedin": the word a resume prints in place of the address.
export const siteOf = (uri) => {
  const host = (/^[a-z]+:\/\/([^\/?#]+)/i.exec(String(uri)) || ["", ""])[1].toLowerCase().replace(/^www\./, "");
  const parts = host.split(".");
  return parts.length >= 2 ? parts[parts.length - 2] : "";
};

// doc: a normalized resume document (lib/resume_doc.js normalizeLayout). scale shrinks type and
// spacing together, margins a little. Returns {bytes, pages}.
export function renderLayout(doc, scale = 1) {
  const st = doc.style, fam = st.font === "serif" ? "serif" : "sans";
  const d = new StyledDoc(st.page, st.margin_in * 72, Math.max(26, st.margin_top_in * 72 * scale));
  const L = d.mx, R = d.W - d.mx, body = st.body_size * scale, lead = body * st.line_gap;
  d.uris = Array.isArray(doc.links) ? doc.links : [];
  // was: no `bare` option, and d.line(..., ln, size, color)
  const put = (s, size, { align = "left", base = {}, color, lh = size * st.line_gap, bare = false } = {}) => {
    for (const ln of wrapRich(s, fam, size, R - L, base)) {
      d.ensure(lh); d.y -= lh;
      d.line(align === "center" ? L + (R - L - ln.w) / 2 : align === "right" ? R - ln.w : L, d.y, ln, size, color, bare);
    }
  };

  const h = doc.header;
  if (h.name) put(st.name_caps ? h.name.toUpperCase() : h.name, st.name_size * scale, { align: st.name_align, base: { b: st.name_bold }, color: st.accent, lh: st.name_size * scale * 1.05 });
  if (h.contact.length) d.y -= body * 0.2;
  // was: put(c, st.contact_size * scale, { align: st.contact_align })
  for (const c of h.contact) put(c, st.contact_size * scale, { align: st.contact_align, bare: true });

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
        // was: const right = wrapRich(row.right, ...)[0] || null, drawn on the first line only. A right-hand
        // text too long for one line ("Amherst, MA | September 2025 - Present | Part time") lost
        // everything after the first wrapped line, and nothing said so. Every line is drawn now.
        const rights = wrapRich(row.right, fam, body, (R - L) * 0.6);
        const rw = rights.reduce((m, r) => Math.max(m, r.w), 0);
        const left = wrapRich(row.left, fam, body, R - L - (rw ? rw + 10 : 0));
        for (let k = 0; k < Math.max(left.length, rights.length, 1); k++) {
          d.ensure(lead); d.y -= lead;
          if (left[k]) d.line(L, d.y, left[k], body);
          if (rights[k]) d.line(R - rights[k].w, d.y, rights[k], body);
        }
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
  // was: return { bytes: d.bytes(), pages: d.pages.length };
  return { bytes: d.bytes(), pages: d.pages.length, linked: d.linked || [] };
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
