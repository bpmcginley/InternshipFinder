// A tailored resume has to look like the one the student uploaded, and may only reword what is on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encode, parseRich, plain, renderLayout, renderLayoutFit, widthIn, wrapRich } from "../lib/pdf_layout.js";
import { applyDocTailoring, docTailorInput, docText, layoutMatchesProfile, normalizeLayout } from "../lib/resume_doc.js";
import { crc32, entryBytes, readZip, withContent, writeZip } from "../lib/zip.js";
import { applyDocxTailoring, bulletGroups, docxTailorInput, openDocx, saveDocx } from "../lib/docx.js";
import { toB64 } from "../lib/pdf.js";

const latin = (bytes) => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return s; };

const raw = () => ({
  style: { font: "serif", body_size: 10, name_size: 22, heading_size: 11, name_align: "left", heading: { caps: true, bold: true, rule: "below" }, bullet: "\u2022", margin_in: 0.75, pages: 1, accent: "#1a3c6e" },
  header: { name: "Jos\u00e9 Lee", contact: ["jose@example.edu | 555-0100 | Amherst, MA"] },
  sections: [
    { title: "Education", entries: [{ rows: [{ left: "**UMass Amherst**", right: "Amherst, MA" }, { left: "*BS Biology*, GPA 3.6", right: "May 2028" }] }] },
    { title: "Experience", entries: [{ rows: [{ left: "**Kim Lab**", right: "2025 \u2013 Present" }, { left: "*Research Assistant*" }],
      bullets: ["Ran 40 PCR assays weekly for a **3-person** team", "Kept the lab notebook", "Ordered supplies"] }] },
    { title: "Leadership", entries: [{ rows: [{ left: "**Biology Club**, Treasurer", right: "2024" }], bullets: ["Managed a $2,000 budget"] }] },
    { title: "Technical Skills", lines: ["**Languages:** Python, R, MATLAB", "**Lab:** PCR, gel electrophoresis"] },
  ],
});
const store = () => ({ profile: { facts: { last_name: "Lee" }, experience: [{ company: "Kim Lab" }], education: [{ school: "UMass Amherst" }] } });

test("text keeps its accents, dashes and quotes; exotic bullets fold to a real bullet", () => {
  assert.equal(encode("Jos\u00e9"), "Jos\u00e9");
  assert.equal(encode("2025 \u2013 Present"), "2025 \u0096 Present");
  assert.equal(encode("\u25aa item \u2192 next"), "\u0095 item -> next");
  assert.equal(encode("\u4e2d"), "");
  assert.ok(widthIn("Times-Bold", "W", 10) > widthIn("Times-Roman", "i", 10));
});

test("bold and italic marks parse, and wrapping never exceeds the width", () => {
  assert.deepEqual(parseRich("a **b** *c*").map((x) => [x.text, x.b, x.i]), [["a ", false, false], ["b", true, false], [" ", false, false], ["c", false, true]]);
  assert.equal(plain("**Languages:** Python"), "Languages: Python");
  const lines = wrapRich("**Languages:** Python, Java, C++ and a long list of other things that has to wrap at some point", "serif", 10, 180);
  assert.ok(lines.length > 1);
  for (const l of lines) assert.ok(l.w <= 180);
  assert.equal(lines[0].atoms[0].font, "Times-Bold");
});

test("a bad layout is refused, a good one is clamped", () => {
  assert.equal(normalizeLayout(null), null);
  assert.equal(normalizeLayout({ header: { name: "X" }, sections: [] }), null);
  const doc = normalizeLayout({ ...raw(), style: { ...raw().style, body_size: 99, margin_in: -3, font: "comic" } });
  assert.equal(doc.style.body_size, 12);
  assert.equal(doc.style.margin_in, 0.3);
  assert.equal(doc.style.font, "sans");
  assert.equal(doc.sections.length, 4);
});

test("the layout must be the student's own resume", () => {
  const doc = normalizeLayout(raw());
  assert.equal(layoutMatchesProfile(doc, store()), true);
  assert.equal(layoutMatchesProfile(doc, { profile: { facts: { last_name: "Nguyen" }, experience: [], education: [] } }), false);
  assert.equal(layoutMatchesProfile(doc, { profile: { facts: { last_name: "Lee" }, experience: [{ company: "Globex" }, { company: "Initech" }], education: [{ school: "Harvard" }] } }), false);
});

test("the styled PDF is well formed, keeps every section, and uses the original's font family", () => {
  const doc = normalizeLayout(raw());
  const { bytes, pages } = renderLayout(doc);
  const pdf = latin(bytes);
  assert.equal(pages, 1);
  assert.ok(pdf.startsWith("%PDF-1.4"));
  assert.ok(pdf.trimEnd().endsWith("%%EOF"));
  const xref = Number(/startxref\n(\d+)/.exec(pdf)[1]);
  assert.equal(pdf.slice(xref, xref + 4), "xref");
  for (const m of pdf.matchAll(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g)) assert.equal(m[2].length, Number(m[1]));
  assert.ok(pdf.includes("/BaseFont /Times-Bold"));
  assert.ok(/\/F5 [\d.]+ Tf/.test(pdf), "body text is set in Times-Roman");
  assert.ok(!/\/F1 [\d.]+ Tf/.test(pdf), "no Helvetica in a serif resume");
  for (const word of ["LEADERSHIP", "TECHNICAL", "Treasurer", "Jos\u00e9"]) assert.ok(pdf.includes(word), word);
  assert.ok(pdf.includes("0.102 0.235 0.431 rg"), "accent colour carried over");
});

test("a resume that grows is shrunk back onto its original page count", () => {
  const big = raw();
  big.sections[1].entries[0].bullets = Array.from({ length: 46 }, (_, i) => `Bullet ${i} that is long enough to fill most of a line on the page for sure`);
  const doc = normalizeLayout({ ...big, sections: [big.sections[1], { ...big.sections[1], title: "More" }, { ...big.sections[1], title: "Even more" }, { ...big.sections[1], title: "Last" }] });
  assert.ok(renderLayout(doc).pages > 1);
  const fit = renderLayoutFit(doc);
  assert.ok(fit.scale < 1);
  assert.ok(fit.pages <= renderLayout(doc).pages);
});

test("doc tailoring: reword kept, invented numbers and header rows refused, skills only reorder", () => {
  const doc = normalizeLayout(raw());
  assert.equal(docTailorInput(doc)[3].kind, "skills");
  const { doc: next, diff } = applyDocTailoring(doc, {
    entries: [
      { s: 1, e: 0, bullets: [{ from: 2, text: "Ordered lab supplies" }, { from: 0, text: "Ran 90 PCR assays weekly" }, { from: 9, text: "Invented" }] },
      { s: 0, e: 0, rows: [{ left: "Harvard" }], bullets: [{ from: 0, text: "Made up" }] },
      { s: 2, e: 0, bullets: [{ from: 0, text: "Managed a $2,000 club budget **now**" }] },
    ],
    lines: [{ s: 3, k: 0, text: "**Languages:** R, Python, Rust" }, { s: 3, k: 1, text: "Lab: CRISPR" }],
  });
  const b = next.sections[1].entries[0].bullets;
  assert.deepEqual(b, ["Ordered lab supplies", "Ran 40 PCR assays weekly for a **3-person** team"]); // one dropped from 3, the 90 refused
  assert.deepEqual(next.sections[0], doc.sections[0]);
  assert.equal(next.sections[2].entries[0].bullets[0], "Managed a $2,000 club budget now"); // stray marks removed
  assert.equal(next.sections[3].lines[0], "**Languages:** R, Python, MATLAB");
  assert.equal(next.sections[3].lines[1], doc.sections[3].lines[1]);
  assert.equal(diff.length, 3);
  assert.ok(docText(next).includes("Biology Club"));
  assert.deepEqual(applyDocTailoring(doc, "garbage").doc.sections, doc.sections);
});

test("doc tailoring: a bullet may not balloon, and no summary is invented", () => {
  const doc = normalizeLayout(raw());
  const long = "Kept the lab notebook " + "and many other things ".repeat(8);
  const { doc: next } = applyDocTailoring(doc, { entries: [{ s: 1, e: 0, bullets: [{ from: 1, text: long }] }], lines: [{ s: 0, k: 0, text: "A new summary" }] });
  assert.ok(next.sections[1].entries[0].bullets.includes("Kept the lab notebook"));
  assert.equal(next.sections.length, doc.sections.length);
  assert.deepEqual(next.sections[0].lines, []);
});

// ---------- Word ----------
const P = (text, { bullet = false, bold = false, glyph = "" } = {}) =>
  `<w:p w:rsidR="00A1"><w:pPr>${bullet ? `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>` : ""}<w:spacing w:after="0"/></w:pPr>` +
  (glyph ? `<w:r><w:t>${glyph}</w:t><w:tab/></w:r>` : "") +
  `<w:r><w:rPr>${bold ? "<w:b/>" : ""}<w:rFonts w:ascii="Garamond"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const DOC = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`;
const BODY = P("Sam Lee", { bold: true }) + P("EXPERIENCE", { bold: true }) + P("Kim Lab", { bold: true }) + P("Research Assistant\t2025") +
  P("Ran 40 PCR assays weekly", { bullet: true }) + P("Kept the lab notebook &amp; protocols", { bullet: true }) + P("Ordered supplies for the team", { bullet: true }) +
  P("PROJECTS", { bold: true }) + P("Modeled tides in Python", { glyph: "\u2022" }) + P("Presented results at a poster session", { glyph: "\u2022" });

async function docx(body) {
  const enc = new TextEncoder();
  const file = (name, text) => { const data = enc.encode(text); return { name, method: 0, flags: 0, time: 0, date: 33, crc: crc32(data), csize: data.length, usize: data.length, data }; };
  const entries = [file("[Content_Types].xml", "<Types/>"), await withContent(file("word/document.xml", ""), enc.encode(DOC(body))), file("word/styles.xml", "<w:styles>Garamond</w:styles>")];
  return writeZip(entries);
}

test("zip: round trip, untouched entries byte for byte", async () => {
  const bytes = await docx(BODY);
  const entries = readZip(bytes);
  assert.deepEqual(entries.map((e) => e.name), ["[Content_Types].xml", "word/document.xml", "word/styles.xml"]);
  assert.equal(new TextDecoder().decode(await entryBytes(entries[2])), "<w:styles>Garamond</w:styles>");
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
  assert.throws(() => readZip(new Uint8Array(40)), /not a zip/);
});

test("docx: finds bullet groups with their context, numbered or typed", async () => {
  const opened = await openDocx(toB64(await docx(BODY)));
  const parsed = bulletGroups(opened.xml);
  const input = docxTailorInput(parsed);
  assert.equal(input.length, 2);
  assert.equal(input[0].under, "Kim Lab / Research Assistant 2025");
  assert.deepEqual(input[0].bullets.map((b) => b.text), ["Ran 40 PCR assays weekly", "Kept the lab notebook & protocols", "Ordered supplies for the team"]);
  assert.deepEqual(input[1].bullets.map((b) => b.text), ["Modeled tides in Python", "Presented results at a poster session"]);
});

test("docx: only the reworded words change; formatting, order of slots and other parts stay", async () => {
  const opened = await openDocx(toB64(await docx(BODY)));
  const parsed = bulletGroups(opened.xml);
  const { xml, diff } = applyDocxTailoring(opened.xml, parsed, { groups: [
    { g: 0, bullets: [{ from: 1, text: "Maintained lab notebook & <protocols>" }, { from: 0, text: "Ran 400 PCR assays weekly" }, { from: 2, text: "Ordered supplies for the team" }] },
    { g: 1, bullets: [{ from: 1, text: "Presented results at a poster session" }, { from: 0, text: "Modeled tides in **Python**" }] },
  ] });
  assert.equal(diff.length, 1); // the 400 was refused; the ** marks are not a change
  const after = docxTailorInput(bulletGroups(xml));
  assert.deepEqual(after[0].bullets.map((b) => b.text), ["Maintained lab notebook & <protocols>", "Ran 40 PCR assays weekly", "Ordered supplies for the team"]);
  assert.deepEqual(after[1].bullets.map((b) => b.text), ["Presented results at a poster session", "Modeled tides in Python"]);
  assert.ok(xml.includes("&amp; &lt;protocols&gt;"));
  assert.equal((xml.match(/<w:numPr>/g) || []).length, 3);
  assert.equal((xml.match(/<w:t>\u2022<\/w:t><w:tab\/>/g) || []).length, 2, "typed bullet glyphs stay in front");
  assert.equal((xml.match(/Garamond/g) || []).length, (opened.xml.match(/Garamond/g) || []).length);
  assert.ok(xml.includes("<w:sectPr>") && xml.startsWith("<?xml"));

  const saved = await saveDocx(opened, xml);
  const back = await openDocx(toB64(saved));
  assert.equal(back.xml, xml);
  assert.equal(new TextDecoder().decode(await entryBytes(back.entries[2])), "<w:styles>Garamond</w:styles>");
});

test("docx: one bullet may drop from three, and paragraphs it cannot read are left alone", async () => {
  const opened = await openDocx(toB64(await docx(BODY)));
  const parsed = bulletGroups(opened.xml);
  const { xml } = applyDocxTailoring(opened.xml, parsed, { groups: [{ g: 0, bullets: [{ from: 2, text: "Ordered supplies for the team" }, { from: 0, text: "Ran 40 PCR assays weekly" }] }, { g: 1, bullets: [{ from: 0, text: "Modeled tides" }] }] });
  const after = docxTailorInput(bulletGroups(xml));
  assert.deepEqual(after[0].bullets.map((b) => b.text), ["Ordered supplies for the team", "Ran 40 PCR assays weekly"]);
  assert.equal(after[1].bullets.length, 2); // a group of two never loses one

  const odd = BODY.replace("Ordered supplies for the team</w:t>", "Ordered supplies for the team</w:t><w:drawing/>");
  const o2 = await openDocx(toB64(await docx(odd)));
  assert.deepEqual(docxTailorInput(bulletGroups(o2.xml))[0].bullets.map((b) => b.text), ["Ran 40 PCR assays weekly", "Kept the lab notebook & protocols"]);
  assert.deepEqual(applyDocxTailoring(o2.xml, bulletGroups(o2.xml), null).xml, o2.xml);
});
