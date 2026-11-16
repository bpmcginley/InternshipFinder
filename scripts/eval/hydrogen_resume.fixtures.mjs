// Fictional whole resumes for the local Gemini tailoring benchmark.
import assert from "node:assert/strict";
import { crc32, writeZip } from "../../extension/lib/zip.js";
import { renderLayout } from "../../extension/lib/pdf_layout.js";
import { normalizeLayout } from "../../extension/lib/resume_doc.js";
import { emptyStore } from "../../extension/lib/store.js";

export const fixtures = [
  {
    id: "word-analytics",
    format: "docx",
    person: "Casey Sample",
    font: "Garamond",
    field: "reporting",
    roles: [
      [
        "Cedar Data Collective",
        "Analytics Assistant",
        [
          "Cleaned **Python** survey records for 120 entries before analysis.",
          "Prepared weekly tables for the research lead.",
          "Documented the survey coding rules in a team guide.",
          "Filed the team's printed meeting agendas.",
        ],
      ],
      [
        "Maple Campus Library",
        "Desk Assistant",
        [
          "Logged 35 equipment loans each week.",
          "Explained borrowing rules to students at the desk.",
          "Tracked which laptops needed repair.",
        ],
      ],
    ],
    project: [
      "Campus Transit Review",
      "Compared 4 bus routes using a spreadsheet of public timetables.",
    ],
    job: "The intern will prepare survey data for reporting, document data quality decisions, and write concise summaries for research staff. The description lists Tableau, SQL, and Power BI as preferred skills, but the applicant may only describe technologies they actually used. Staff review the input files weekly.",
  },
  {
    id: "word-operations",
    format: "docx",
    person: "Avery Example",
    font: "Calibri",
    field: "operations",
    roles: [
      [
        "Harbor Service Center",
        "Operations Assistant",
        [
          "Tracked **18** incoming requests in a shared spreadsheet.",
          "Wrote a guide for labeling requests by priority.",
          "Reviewed open requests with a supervisor each Friday.",
          "Filed receipts in date order.",
        ],
      ],
      [
        "Willow Campus Events",
        "Events Volunteer",
        [
          "Checked 48 registrations against the guest list.",
          "Helped volunteers prepare signs and supplies.",
          "Recorded questions to answer at the next event.",
        ],
      ],
    ],
    project: ["Tool Room Checklist", "Created a 6-step checklist for returning shared supplies."],
    job: "The intern will improve service request tracking and document handoffs. The group uses Salesforce and reports on service response time, but the posting requests that students describe specific experience with spreadsheets, request categorization, and clear documentation. Experience with formal process improvement is useful but optional.",
  },
  {
    id: "pdf-environment",
    format: "pdf_layout",
    person: "Taylor Demo",
    font: "serif",
    field: "research",
    roles: [
      [
        "Juniper Field Program",
        "Field Assistant",
        [
          "Recorded **24** stream measurements in a shared log.",
          "Checked sample labels against the daily route sheet.",
          "Prepared a handoff note for the next shift.",
          "Cleaned field equipment after each collection.",
        ],
      ],
      [
        "Fern Campus Garden",
        "Volunteer",
        [
          "Tallied 36 garden sign-ups.",
          "Documented the supplies needed for weekly shifts.",
          "Prepared a map for volunteers.",
        ],
      ],
    ],
    project: ["Trail Map", "Compared 3 trail segments using a public map."],
    job: "The research intern will record field measurements, review sample metadata, and prepare handoffs for technicians. ArcGIS, laboratory analysis, and experience leading field crews are optional. The team uses standard collection protocols and prefers applicants who can distinguish their own actions from outcomes they did not measure.",
  },
  {
    id: "profile-software",
    format: "template",
    person: "Riley Fiction",
    font: "sans",
    field: "engineering",
    roles: [
      [
        "Oak Learning Studio",
        "Student Developer",
        [
          "Wrote 12 unit tests for a small JavaScript utility.",
          "Fixed error messages for empty form fields.",
          "Documented how to reproduce 3 UI issues.",
          "Organized design screenshots.",
        ],
      ],
      [
        "Pine Media Lab",
        "Support Assistant",
        [
          "Checked 22 laptop reservations each week.",
          "Helped new users connect displays and cameras.",
          "Recorded common questions for the support guide.",
        ],
      ],
    ],
    project: ["Course Planner", "Built a JavaScript page to group courses into 4 categories."],
    job: "The intern will help reproduce user interface issues, improve user-facing validation messages, add focused tests, and write documentation. The team uses React, TypeScript, and Playwright, but applicants should only describe tools they have used. Candidates are evaluated on concrete examples of testing and user-facing work.",
  },
];
const markup = (text) => text.replaceAll("**", "");
const esc = (s) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const xmlP = (text, font, bullet = false) => {
  const props = bullet
    ? '<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>'
    : "";
  const spans = text
    .split("**")
    .map(
      (span, i) =>
        '<w:r><w:rPr><w:rFonts w:ascii="' +
        font +
        '"/>' +
        (i % 2 ? "<w:b/>" : "") +
        '</w:rPr><w:t xml:space="preserve">' +
        esc(span) +
        "</w:t></w:r>",
    )
    .join("");
  return "<w:p>" + props + spans + "</w:p>";
};
function zipEntry(name, text) {
  const data = new TextEncoder().encode(text);
  return {
    name,
    method: 0,
    flags: 0,
    time: 0,
    date: 33,
    crc: crc32(data),
    csize: data.length,
    usize: data.length,
    data,
  };
}
export function setup(spec) {
  const store = emptyStore();
  const [first_name, last_name] = spec.person.split(" ");
  const email = first_name.toLowerCase() + "@example.org";
  Object.assign(store.profile.facts, { first_name, last_name, email });
  store.profile.goals.career = spec.field;
  store.profile.voice.summary = "Direct, specific, factual";
  store.profile.education = [
    {
      school: "Example State College",
      degree: "Bachelor of Science",
      major: "Information Systems",
      end: "May 2028",
    },
  ];
  store.profile.experience = spec.roles.map(([company, title, bullets]) => ({
    company,
    title,
    bullets: bullets.map(markup),
  }));
  store.profile.projects = [{ name: spec.project[0], description: spec.project[1] }];
  store.profile.skills.technical = ["Documentation", "Spreadsheets"];
  store.ai = { provider: "internscout" };
  store.settings.tailor_resume = "auto";
  if (spec.format === "docx") {
    const p = (s, b) => xmlP(s, spec.font, b);
    const body =
      p(spec.person) +
      p(email) +
      p("EDUCATION") +
      p("Example State College") +
      p("Bachelor of Science in Information Systems, May 2028") +
      p("EXPERIENCE") +
      spec.roles
        .map(
          ([company, title, bullets]) =>
            p(company) + p(title) + bullets.map((b) => p(b, true)).join(""),
        )
        .join("") +
      p("PROJECTS") +
      p(spec.project[0]) +
      p(spec.project[1], true) +
      p("SKILLS") +
      p("Documentation, Spreadsheets");
    const bytes = writeZip([
      zipEntry(
        "[Content_Types].xml",
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>',
      ),
      zipEntry(
        "_rels/.rels",
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
      zipEntry(
        "word/_rels/document.xml.rels",
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>',
      ),
      zipEntry(
        "word/numbering.xml",
        '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>',
      ),
      zipEntry(
        "word/document.xml",
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
          body +
          "<w:sectPr/></w:body></w:document>",
      ),
    ]);
    store.files.resume = {
      name: "sample.docx",
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      b64: Buffer.from(bytes).toString("base64"),
    };
  } else if (spec.format === "pdf_layout") {
    const doc = normalizeLayout({
      columns: 1,
      graphics: false,
      style: {
        font: spec.font,
        body_size: 10,
        name_size: 22,
        heading_size: 11,
        heading: { caps: true, bold: true, rule: "below" },
        bullet: "-",
        margin_in: 0.75,
        pages: 1,
      },
      header: { name: spec.person, contact: [email + " | Amherst, MA"] },
      sections: [
        {
          title: "Education",
          entries: [
            {
              rows: [
                { left: "**Example State College**", right: "May 2028" },
                { left: "Bachelor of Science in Information Systems" },
              ],
            },
          ],
        },
        {
          title: "Experience",
          entries: spec.roles.map(([company, title, bullets]) => ({
            rows: [{ left: "**" + company + "**" }, { left: title }],
            bullets,
          })),
        },
        {
          title: "Projects",
          entries: [{ rows: [{ left: spec.project[0] }], bullets: [spec.project[1]] }],
        },
        { title: "Technical Skills", lines: ["**Tools:** Documentation, Spreadsheets"] },
      ],
    });
    assert.ok(doc);
    const { bytes, pages } = renderLayout(doc);
    assert.equal(pages, 1);
    store.files.resume = {
      name: "sample.pdf",
      type: "application/pdf",
      b64: Buffer.from(bytes).toString("base64"),
    };
    return { store, doc };
  }
  return { store };
}
