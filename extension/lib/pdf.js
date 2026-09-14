// Minimal text-only PDF writer (Helvetica, US Letter) for tailored resumes. No dependencies.

// Helvetica advance widths (1/1000 em) for ASCII 32..126.
const WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778,
  722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const BULLET = "\x95"; // WinAnsi bullet

export const clean = (s) => String(s ?? "")
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...").replace(/•/g, BULLET)
  .normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e\x95]/g, "");

export function textWidth(s, size, bold = false) {
  let w = 0;
  for (const c of s) { const k = c.charCodeAt(0); w += k === 0x95 ? 350 : WIDTHS[k - 32] || 556; }
  return (w * size / 1000) * (bold ? 1.06 : 1);
}

export function wrap(s, size, bold, max) {
  const lines = [];
  let cur = "";
  for (const w of clean(s).split(/\s+/).filter(Boolean)) {
    const t = cur ? cur + " " + w : w;
    if (!cur || textWidth(t, size, bold) <= max) cur = t;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

const esc = (s) => s.replace(/[\\()]/g, "\\$&");

export class PdfDoc {
  constructor() { this.pages = []; this.newPage(); }
  newPage() { this.ops = []; this.pages.push(this.ops); this.y = 742; }
  ensure(h) { if (this.y - h < 50) this.newPage(); }
  text(x, y, s, size, bold = false) {
    this.ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${x.toFixed(1)} ${y.toFixed(1)} Td (${esc(clean(s))}) Tj ET`);
  }
  rule(x1, x2, y) { this.ops.push(`0.6 w ${x1} ${y.toFixed(1)} m ${x2} ${y.toFixed(1)} l S`); }
  bytes() {
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    ];
    const kids = [];
    for (const ops of this.pages) {
      const stream = ops.join("\n");
      objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
      objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${objs.length} 0 R >>`);
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

// r: {name, contact[], summary, education[], experience[], projects[], skills{technical,tools,soft}}
export function renderResume(r) {
  const d = new PdfDoc(), L = 50, R = 562;
  const center = (s, size, bold) => { const t = clean(s); d.text((612 - textWidth(t, size, bold)) / 2, d.y, t, size, bold); };
  const lines = (s, size, x, lead) => { for (const ln of wrap(s, size, false, R - x)) { d.ensure(lead); d.y -= lead; d.text(x, d.y, ln, size); } };
  const section = (t) => { d.ensure(46); d.y -= 20; d.text(L, d.y, t.toUpperCase(), 11, true); d.y -= 4; d.rule(L, R, d.y); d.y -= 1; };
  const head = (left, right, sub) => {
    d.ensure(sub ? 42 : 28);
    d.y -= 14;
    const rt = clean(right || ""), room = R - L - (rt ? textWidth(rt, 10) + 12 : 0);
    d.text(L, d.y, wrap(left, 10.5, true, room)[0] || "", 10.5, true);
    if (rt) d.text(R - textWidth(rt, 10), d.y, rt, 10);
    if (sub) { d.y -= 12.5; d.text(L, d.y, wrap(sub, 10, false, R - L)[0] || "", 10); }
  };
  const bullet = (s) => wrap(s, 10, false, R - L - 14).forEach((ln, i) => {
    d.ensure(13); d.y -= 12.5;
    if (!i) d.text(L + 4, d.y, BULLET, 10);
    d.text(L + 14, d.y, ln, 10);
  });
  const span = (a, b) => [a, b].filter(Boolean).join(" - ");

  d.y -= 6; center(r.name || "", 18, true);
  for (const ln of wrap((r.contact || []).filter(Boolean).join("  |  "), 9.5, false, R - L)) { d.y -= 13; center(ln, 9.5); }
  if (r.summary) { section("Summary"); lines(r.summary, 10, L, 13); }
  if ((r.education || []).length) {
    section("Education");
    for (const e of r.education) {
      head(e.school, e.end || e.grad_term, [span(e.degree, e.major), e.minor && `Minor: ${e.minor}`, e.gpa && `GPA: ${e.gpa}`].filter(Boolean).join("  |  "));
      if (e.coursework) lines(`Coursework: ${e.coursework}`, 9.5, L, 12.5);
    }
  }
  if ((r.experience || []).length) {
    section("Experience");
    for (const e of r.experience) {
      head(e.company, span(e.start, e.end), [e.title, e.location].filter(Boolean).join("  |  "));
      (e.bullets || []).forEach(bullet);
    }
  }
  if ((r.projects || []).length) {
    section("Projects");
    for (const p of r.projects) {
      head(p.name, p.dates, [p.role, p.link].filter(Boolean).join("  |  "));
      if (p.description) bullet(p.description);
    }
  }
  const sk = r.skills || {};
  const rows = [["Technical", sk.technical], ["Tools", sk.tools], ["Other", sk.soft]].filter(([, v]) => v && v.length);
  if (rows.length) { section("Skills"); for (const [k, v] of rows) lines(`${k}: ${v.join(", ")}`, 10, L, 13); }
  return d.bytes();
}

export function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
