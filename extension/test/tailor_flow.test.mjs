// The tailoring flow end to end, with a fake model and a fake chrome.storage: which file a student
// gets back, what it costs, and what is remembered between runs. lib/ is covered by
// tailor_format.test.mjs; this file covers background/tailor.js, which decides between the paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32, withContent, writeZip } from "../lib/zip.js";
import { toB64 } from "../lib/pdf.js";
import { sameLink, urisIn } from "../lib/pdf_layout.js";

// ---------- fakes ----------
let data = {};
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) =>
        typeof k === "string"
          ? { [k]: data[k] }
          : Object.fromEntries([].concat(k || []).map((x) => [x, data[x]])),
      set: async (o) => {
        Object.assign(data, o);
      },
      remove: async (k) => {
        delete data[k];
      },
    },
  },
};

// Every model call lands here. `replies` answers by what the system prompt starts with, so a test
// says what the layout reader, the Word tailor, the PDF tailor and the template tailor would reply.
let calls = [],
  sent = [],
  replies = {};
const kindOfCall = (system) =>
  /^You transcribe/.test(system)
    ? "layout"
    : /Word resume/.test(system)
      ? "docx"
      : /JSON sections/.test(system)
        ? "doc"
        : "template";
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body),
    kind = kindOfCall(body.system || "");
  calls.push(kind);
  sent.push(body);
  const reply = replies[kind];
  const text = typeof reply === "string" ? reply : JSON.stringify(reply === undefined ? {} : reply);
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    json: async () => ({
      content: [{ type: "text", text }],
      usage: { input_tokens: 2000, output_tokens: 1000 },
    }),
  };
};
const reset = () => {
  data = {};
  calls = [];
  sent = [];
  replies = {};
};

const { tailorResume } = await import("../background/tailor.js");

const JOB = {
  company: "Acme Bio",
  title: "Research Intern",
  description: "PCR, lab notebooks, Python.",
  run_id: "r1",
};
const profile = (over = {}) => ({
  facts: { first_name: "Jose", last_name: "Lee" },
  goals: { career: "" },
  voice: { summary: "" },
  experience: [
    {
      company: "Kim Lab",
      title: "Research Assistant",
      bullets: ["Ran 40 PCR assays weekly", "Kept the lab notebook", "Ordered supplies"],
    },
  ],
  education: [{ school: "UMass Amherst" }],
  projects: [],
  skills: { technical: [], tools: [], soft: [] },
  ...over,
});
const storeOf = (resume, mode = "review", p = profile()) => ({
  ai: { provider: "anthropic", apiKey: "test" },
  settings: { tailor_resume: mode, ai_mode: "balanced" },
  profile: p,
  files: { resume },
});
const TEMPLATE_REPLY = {
  summary: "",
  experience: [
    {
      i: 0,
      bullets: [
        { from: 0, text: "Ran 40 PCR assays each week" },
        { from: 1, text: "Kept the lab notebook" },
        { from: 2, text: "Ordered supplies" },
      ],
    },
  ],
  projects: [],
  skills: {},
  changes: [],
};

// ---------- a Word file ----------
const P = (text, { bullet = false, font = "Garamond" } = {}) =>
  `<w:p><w:pPr>${bullet ? `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>` : ""}</w:pPr>` +
  `<w:r><w:rPr><w:rFonts w:ascii="${font}"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const DOC = (body) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;
async function docx(font) {
  const enc = new TextEncoder();
  const file = (name, text) => {
    const d = enc.encode(text);
    return {
      name,
      method: 0,
      flags: 0,
      time: 0,
      date: 33,
      crc: crc32(d),
      csize: d.length,
      usize: d.length,
      data: d,
    };
  };
  const body =
    P("Jose Lee", { font }) +
    P("EXPERIENCE", { font }) +
    P("Ran 40 PCR assays weekly", { bullet: true, font }) +
    P("Kept the lab notebook", { bullet: true, font }) +
    P("Ordered supplies for the team", { bullet: true, font });
  const bytes = writeZip([
    file("[Content_Types].xml", "<Types/>"),
    await withContent(file("word/document.xml", ""), enc.encode(DOC(body))),
  ]);
  return { name: "resume.docx", type: "", b64: toB64(bytes) };
}
const DOCX_REPLY = {
  groups: [
    {
      g: 0,
      bullets: [
        { from: 0, text: "Ran 40 PCR assays each week" },
        { from: 1, text: "Kept the lab notebook" },
        { from: 2, text: "Ordered supplies for the team" },
      ],
    },
  ],
  changes: ["PCR first"],
};

test("a new Word file with the same words is tailored again, never served the old file's copy", async () => {
  reset();
  replies.docx = DOCX_REPLY;
  const a = await docx("Garamond"),
    b = await docx("Calibri");
  const first = await tailorResume(storeOf(a), JOB);
  assert.equal(first.format, "docx");
  assert.ok(first.cost_usd > 0);
  const again = await tailorResume(storeOf(a), JOB);
  assert.equal(again.reused, true);
  assert.equal(again.cost_usd, 0);
  assert.deepEqual(calls, ["docx"]); // the second run cost nothing
  const other = await tailorResume(storeOf(b), JOB); // same bullets, another font
  assert.ok(!other.reused);
  assert.deepEqual(calls, ["docx", "docx"]);
  assert.notEqual(other.file.b64, first.file.b64);
});

// ---------- a PDF ----------
const pdf = (extra = "") => ({
  name: "resume.pdf",
  type: "application/pdf",
  b64: Buffer.from(
    `%PDF-1.4\n1 0 obj << /Type /Annot /Subtype /Link /A << /S /URI /URI (https://www.linkedin.com/in/joselee) >> >> endobj\n2 0 obj << /A << /S /URI /URI (mailto:jose@example.edu) >> >> endobj\n${extra}%%EOF`,
    "latin1",
  ).toString("base64"),
});
const layout = (over = {}) => ({
  columns: 1,
  graphics: false,
  style: {
    font: "serif",
    body_size: 10,
    name_size: 22,
    heading_size: 11,
    name_align: "left",
    heading: { caps: true, bold: true, rule: "below" },
    bullet: "-",
    margin_in: 0.75,
    pages: 1,
  },
  header: { name: "Jose Lee", contact: ["jose@example.edu | 555-0100 | LinkedIn"] },
  sections: [
    { title: "Education", entries: [{ rows: [{ left: "**UMass Amherst**", right: "May 2028" }] }] },
    {
      title: "Experience",
      entries: [
        {
          rows: [{ left: "**Kim Lab**", right: "2025" }],
          bullets: ["Ran 40 PCR assays weekly", "Kept the lab notebook", "Ordered supplies"],
        },
      ],
    },
  ],
  ...over,
});
const DOC_REPLY = {
  entries: [
    {
      s: 1,
      e: 0,
      bullets: [
        { from: 0, text: "Ran 40 PCR assays each week" },
        { from: 1, text: "Kept the lab notebook" },
        { from: 2, text: "Ordered supplies" },
      ],
    },
  ],
  lines: [],
  changes: [],
};

test("automatic mode never sends the template in place of the student's own file", async () => {
  reset();
  replies.layout = layout({ columns: 2 });
  replies.template = TEMPLATE_REPLY;
  await assert.rejects(tailorResume(storeOf(pdf(), "auto"), JOB), (e) => {
    assert.match(e.message, /format could not be kept: it is laid out in columns/);
    assert.ok(e.cost_usd > 0); // reading the layout was paid for, and is counted
    return true;
  });
  assert.deepEqual(calls, ["layout"]); // and the template call was never made

  // Review mode still offers the template, labelled as not theirs. The refusal is remembered.
  const made = await tailorResume(storeOf(pdf(), "review"), JOB);
  assert.equal(made.format, "template");
  assert.match(made.note, /laid out in columns/);
  assert.match(made.note, /standard layout, not yours/);
  assert.deepEqual(calls, ["layout", "template"]);
});

test("a student with no file of their own gets the template with no warning", async () => {
  reset();
  replies.template = TEMPLATE_REPLY;
  const made = await tailorResume(storeOf(null, "auto"), JOB);
  assert.equal(made.format, "template");
  assert.equal(made.note, undefined);
});

test("a reply that was cut short is tried again after an hour, not remembered for good", async () => {
  reset();
  replies.layout = "sorry, I cannot";
  replies.template = TEMPLATE_REPLY;
  await tailorResume(storeOf(pdf()), JOB);
  await tailorResume(storeOf(pdf()), JOB);
  assert.deepEqual(calls, ["layout", "template"]); // within the hour: neither is asked again
  data.resume_layout.created = Date.now() - 2 * 60 * 60 * 1000;
  replies.layout = layout();
  replies.doc = DOC_REPLY;
  const made = await tailorResume(storeOf(pdf()), JOB);
  assert.equal(made.format, "pdf_layout");
  assert.deepEqual(calls, ["layout", "template", "layout", "doc"]);
});

test("a profile filled in after the upload is matched against the saved reading", async () => {
  reset();
  replies.layout = layout();
  replies.doc = DOC_REPLY;
  replies.template = TEMPLATE_REPLY;
  const stranger = profile({ facts: { first_name: "Ann", last_name: "Nguyen" } });
  const first = await tailorResume(storeOf(pdf(), "review", stranger), JOB);
  assert.equal(first.format, "template");
  assert.match(first.note, /does not match the name/);
  const made = await tailorResume(storeOf(pdf()), JOB); // the profile now says Lee
  assert.equal(made.format, "pdf_layout");
  assert.equal(calls.filter((c) => c === "layout").length, 1); // the PDF was read once
});

test("links hidden behind words come over from the original PDF, and a lost one is said", async () => {
  reset();
  replies.layout = layout();
  replies.doc = DOC_REPLY;
  const made = await tailorResume(storeOf(pdf()), JOB);
  const out = Buffer.from(made.file.b64, "base64").toString("latin1");
  assert.match(out, /\/URI \(https:\/\/www\.linkedin\.com\/in\/joselee\)/); // the word "LinkedIn" is clickable again
  assert.match(out, /\/URI \(mailto:jose@example\.edu\)/);
  assert.doesNotMatch(made.note, /could not be carried over/);

  reset();
  replies.layout = layout();
  replies.doc = DOC_REPLY;
  const lost = await tailorResume(
    storeOf(pdf("3 0 obj << /A << /URI (https://josephlee.dev/work) >> >> endobj\n")),
    JOB,
  );
  assert.match(lost.note, /One link from your PDF could not be carried over \(josephlee\)/);
});

test("a PDF with letters the builder cannot draw keeps the original", async () => {
  reset();
  const l = layout();
  l.header.name = "\u674e Lee";
  replies.layout = l;
  await assert.rejects(
    tailorResume(storeOf(pdf(), "auto"), JOB),
    /letters the PDF builder cannot draw/,
  );
});

test("urisIn reads link addresses and nothing else", () => {
  const b64 = (s) => Buffer.from(s, "latin1").toString("base64");
  assert.deepEqual(
    urisIn(
      b64(
        "/URI (https://a.com/x\\(1\\)) /URI(mailto:a@b.co) /URI (javascript:alert\\(1\\)) /URI (https://a.com/x\\(1\\))",
      ),
    ),
    ["https://a.com/x(1)", "mailto:a@b.co"],
  );
  assert.deepEqual(urisIn("not base64 !!"), []);
  assert.deepEqual(urisIn(""), []);
  assert.equal(sameLink("https://www.LinkedIn.com/in/jane/", "linkedin.com/in/jane"), true);
  assert.equal(sameLink("https://a.com/x", "https://a.com/y"), false);
});

// Reconstruct the previous public key contract from the current real hash inputs. Only synthetic
// fixtures are used. This checks the actual path keys, rather than a separate test-only version.
test("all three paths ignore old-version cache entries and reuse newly checked results", async () => {
  const { tailorKey } = await import("../lib/tailor_cache.js");
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  const decodeKey = (raw) => {
    const values = [];
    let at = 0;
    for (let n = 0; n < 3; n++) {
      const end = raw.indexOf(":", at),
        size = Number(raw.slice(at, end));
      values.push(raw.slice(end + 1, end + 1 + size));
      at = end + 1 + size;
    }
    return values;
  };
  for (const original of [null, await docx("Garamond"), pdf()]) {
    reset();
    let keyInput;
    crypto.subtle.digest = async (algorithm, bytes) => {
      const text = new TextDecoder().decode(bytes);
      if (text.includes("\nfacts-4")) keyInput = text;
      return digest(algorithm, bytes);
    };
    try {
      // Default fake replies leave the original unchanged but still exercise file construction/cache.
      if (original?.type === "application/pdf") replies.layout = layout();
      const store = storeOf(original);
      const fresh = await tailorResume(store, JOB);
      assert.ok(keyInput, "real cache key includes the validation version");
      assert.ok(!fresh.reused);
      const count = calls.length;
      const warm = await tailorResume(store, JOB);
      assert.equal(warm.reused, true);
      assert.equal(calls.length, count);
      const [model, system, prompt] = decodeKey(keyInput);
      const withoutLocalFacts = prompt.slice(0, prompt.lastIndexOf("\nLOCAL_FACTS:"));
      const priorPrompt = original
        ? withoutLocalFacts.replace("\nfacts-4\n", "\nformat-2\n")
        : withoutLocalFacts.replace(/\nfacts-4$/, "");
      const legacyPrompts = [priorPrompt, withoutLocalFacts.replace("\nfacts-4", "\nfacts-3")];
      for (const legacyPrompt of legacyPrompts) {
        const oldKey = await tailorKey(model, system, legacyPrompt);
        data.tailor_cache = {
          [oldKey]: { at: Date.now(), value: { file: { name: "unchecked-old" }, diff: [] } },
        };
        const before = calls.length;
        const rebuilt = await tailorResume(store, JOB);
        assert.notEqual(rebuilt.file.name, "unchecked-old");
        assert.ok(!rebuilt.reused);
        assert.equal(calls.length, before + 1);
        const again = await tailorResume(store, JOB);
        assert.equal(again.reused, true);
        assert.equal(calls.length, before + 1);
      }
      // A different posting still cannot reuse the prior posting's checked cache entry.
      await tailorResume(store, {
        ...JOB,
        description: JOB.description + " Different synthetic role.",
      });
      assert.equal(calls.length, count + legacyPrompts.length + 1);
    } finally {
      crypto.subtle.digest = digest;
    }
  }
});

test("posting requirements cannot become resume facts through any model response path", async () => {
  for (const original of [null, await docx("Garamond"), pdf()]) {
    reset();
    replies.layout = layout();
    const bullets = [
      { from: 0, text: "Improved scores 40%" },
      { from: 1, text: "Used Kubernetes" },
      {
        from: 2,
        text: original?.name?.endsWith(".docx")
          ? "Ordered supplies for the team"
          : "Ordered supplies",
      },
    ];
    replies.template = { summary: "Kubernetes expert", experience: [{ i: 0, bullets }] };
    replies.doc = { entries: [{ s: 1, e: 0, bullets }] };
    replies.docx = { groups: [{ g: 0, bullets }] };
    const result = await tailorResume(storeOf(original), {
      ...JOB,
      description:
        "Kubernetes expertise and improving scores 40% are desired for this synthetic job.",
    });
    assert.deepEqual(result.diff, []);
    assert.equal(result.summary, "");
    assert.equal(calls.length, original?.type === "application/pdf" ? 2 : 1);
  }
});

test("template GPA and graduation changes invalidate cached PDF and summary without adding model facts", async () => {
  for (const [field, before, after, summary] of [
    ["gpa", "3.9", "3.2", "Student with GPA 3.9"],
    ["end", "May 2028", "May 2029", "Graduating in 2028"],
  ]) {
    reset();
    const store = storeOf(null);
    store.profile.education[0][field] = before;
    replies.template = { summary };
    const first = await tailorResume(store, JOB);
    assert.equal(first.summary, summary);
    assert.equal((await tailorResume(store, JOB)).reused, true);
    assert.equal(calls.length, 1);
    store.profile.education[0][field] = after;
    const changed = await tailorResume(store, JOB);
    assert.ok(!changed.reused);
    assert.equal(changed.summary, "");
    assert.notEqual(changed.file.b64, first.file.b64);
    assert.ok(Buffer.from(changed.file.b64, "base64").toString("latin1").includes(after));
    assert.deepEqual(sent[1].messages, sent[0].messages);
    assert.equal((await tailorResume(store, JOB)).reused, true);
    assert.equal(calls.length, 2);
  }
});

test("local cache identity covers render-only fields but excludes unrelated profile metadata", async () => {
  const edits = [
    (s) => (s.profile.education[0].start = "2024"),
    (s) => (s.profile.education[0].grad_term = "Fall 2029"),
    (s) => (s.profile.education[0].coursework = "Synthetic coursework"),
    (s) => (s.profile.experience[0].start = "2024"),
    (s) => (s.profile.experience[0].end = "2026"),
    (s) => (s.profile.experience[0].location = "Synthetic location"),
    (s) => (s.profile.projects[0].dates = "2026"),
    (s) => (s.profile.projects[0].role = "Synthetic role"),
    (s) => (s.profile.projects[0].link = "https://example.test/project"),
    (s) => (s.profile.facts.first_name = "Casey"),
    (s) => (s.settings.signup_email = "synthetic@example.test"),
  ];
  for (const edit of edits) {
    reset();
    const store = storeOf(null);
    store.profile.projects = [{ name: "Synthetic project", description: "Kept records" }];
    await tailorResume(store, JOB);
    edit(store);
    assert.ok(!(await tailorResume(store, JOB)).reused);
    assert.equal(calls.length, 2);
    assert.deepEqual(sent[1].messages, sent[0].messages);
    store.profile.unrelated_note = "Synthetic ignored metadata";
    store.profile.education[0].internal_note = "Synthetic ignored metadata";
    store.settings.theme = "dark";
    assert.equal((await tailorResume(store, JOB)).reused, true);
    assert.equal(calls.length, 2);
  }
});

test("format-preserving cache identity follows profile-derived output filename", async () => {
  for (const original of [await docx("Garamond"), pdf()]) {
    reset();
    replies.layout = layout();
    const store = storeOf(original);
    const first = await tailorResume(store, JOB);
    const count = calls.length;
    // Last name still matches the fixture layout, so this isolates the derived filename.
    store.profile.facts.first_name = "Casey";
    const changed = await tailorResume(store, JOB);
    assert.ok(!changed.reused);
    assert.notEqual(changed.file.name, first.file.name);
    assert.equal(calls.length, count + 1);
    assert.equal((await tailorResume(store, JOB)).reused, true);
  }
});

test("stopping Word, PDF and template tailoring cancels the active request without a fallback", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [file, expected] of [
      [await docx("Garamond"), "docx"],
      [pdf(), "layout"],
      [null, "template"],
    ]) {
      reset();
      const controller = new AbortController();
      let onRequest;
      const requested = new Promise((resolve) => {
        onRequest = resolve;
      });
      const attempts = [];
      globalThis.fetch = async (_url, init) => {
        attempts.push(kindOfCall(JSON.parse(init.body).system));
        onRequest(init.signal);
        return new Promise((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
            once: true,
          });
        });
      };
      const result = tailorResume(storeOf(file), JOB, {
        signal: controller.signal,
      });
      const rejection = assert.rejects(result, { name: "AbortError" });
      const sentSignal = await requested;
      controller.abort();
      await rejection;
      assert.equal(sentSignal, controller.signal);
      assert.deepEqual(attempts, [expected]);
      assert.deepEqual(data, {});
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an already canceled resume job does not make a model request", async () => {
  reset();
  const signal = AbortSignal.abort();
  await assert.rejects(tailorResume(storeOf(null), JOB, { signal }), {
    name: "AbortError",
  });
  assert.deepEqual(calls, []);
});
