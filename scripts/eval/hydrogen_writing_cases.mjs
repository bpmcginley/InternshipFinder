export const writingCases = [
  {
    id: "application-reliability",
    kind: "application",
    posting:
      "Nimbus Transit needs a data intern to trace broken feeds and explain findings to operations.",
    question: "Why are you interested in this role?",
    limit: 360,
    facts: [
      "At a campus bike library, I wrote a Python checker for checkout CSVs and flagged duplicate rows.",
      "I walked two volunteers through the error report and revised the labels after their feedback.",
      "I want to learn how a larger team keeps shared data dependable.",
    ],
    rubric:
      "Connect a specific checker or report improvement to feed reliability or explaining issues. No transit industry experience, scale, or metric is documented.",
  },
  {
    id: "application-teamwork",
    kind: "application",
    posting:
      "Lakewatch Cooperative wants an intern who can collaborate with volunteers during field projects.",
    question: "Tell us about a time you resolved a disagreement on a team.",
    limit: 460,
    facts: [
      "On a four-person volunteer mapping team, two teammates disagreed about requiring a photo for each pin.",
      "I asked each person what they were trying to prevent. We tried optional photos with a reminder on six pins.",
      "The team adopted that approach for the rest of our mapping session. We did not track how many photos volunteers submitted.",
    ],
    rubric:
      "Give the disagreement, the candidate's response, and the team's actual outcome. No improvement in photo submissions is documented.",
  },
  {
    id: "application-accessibility",
    kind: "application",
    posting:
      "Oak Library is hiring a design intern to improve the accessibility of online public forms.",
    question: "Describe one accessibility improvement you made and its result.",
    limit: 380,
    facts: [
      "I added visible labels and adjusted tab order in a student club's event registration form.",
      "Two classmates tried it with a keyboard and told me they could reach the registration button.",
      "I did not run a screen-reader audit or certify standards compliance.",
    ],
    rubric:
      "Name a concrete improvement and keyboard feedback. Do not claim an audit, certification, or screen-reader result.",
  },
  {
    id: "application-transferable",
    kind: "application",
    posting:
      "Pine Finance wants a research intern who can review messy spreadsheets and learn financial modeling.",
    question: "What experience prepares you for this role?",
    limit: 320,
    facts: [
      "I reconciled attendance sheets for a tutoring program using spreadsheet filters and lookup formulas.",
      "I documented how I matched duplicate student names for the next coordinator.",
      "I have not built a financial model.",
    ],
    rubric:
      "Connect reconciliation or documentation to the role. Do not claim financial modeling or use of an unlisted tool.",
  },
  {
    id: "application-no-metric",
    kind: "application",
    posting: "Maple Studio wants an intern to write practical documentation for internal tools.",
    question: "What was the measurable impact of a documentation improvement you led?",
    limit: 340,
    facts: [
      "I rewrote setup instructions for a volunteer inventory tool, adding a checklist and a troubleshooting section.",
      "A new volunteer said they used it to set up the tool without asking for help.",
      "I did not measure setup times or track usage beyond that feedback.",
    ],
    rubric:
      "Describe the change and observed feedback. State the absence of a tracked metric or clearly present the feedback as qualitative. Do not invent time saved.",
  },
  {
    id: "resume-validation",
    kind: "resume",
    posting:
      "Maintain Python ETL jobs, validate input files, and coordinate data-quality issues with partners.",
    question: "Tailor this resume bullet for the posting.",
    limit: 28,
    facts: [
      "Wrote a Python script that checked 250 CSV rows for missing IDs and shared a list of problems with a teammate.",
    ],
    rubric:
      "Lead with validation and preserve 250 rows, CSV, Python, missing IDs and teammate sharing. No production ETL, prevention rate or automation schedule is documented.",
  },
  {
    id: "resume-support",
    kind: "resume",
    posting: "Improve knowledge-base articles and help colleagues diagnose everyday IT issues.",
    question: "Tailor this resume bullet for the posting.",
    limit: 28,
    facts: [
      "Updated 12 help articles about resetting campus Wi-Fi and answered basic setup questions during two help-desk shifts.",
    ],
    rubric:
      "Retain 12 articles, campus Wi-Fi resets and two shifts. Do not claim a ticket-resolution rate, leadership, or organization-wide rollout.",
  },
  {
    id: "resume-analysis",
    kind: "resume",
    posting:
      "Help a public health team clean survey records and summarize findings for a nontechnical audience.",
    question: "Tailor this resume bullet for the posting.",
    limit: 28,
    facts: [
      "Removed duplicate entries from a 90-response campus survey in Excel and presented three charts in class.",
    ],
    rubric:
      "Retain 90 responses, Excel, duplicate removal and three charts in class. Do not turn a campus exercise into public-health or professional experience.",
  },
  {
    id: "resume-testing",
    kind: "resume",
    posting: "Contribute to software quality by writing unit tests and documenting failures.",
    question: "Tailor this resume bullet for the posting.",
    limit: 28,
    facts: [
      "Added 8 unit tests for a Java assignment's input parser and wrote notes explaining two bugs I found.",
    ],
    rubric:
      "Retain 8 unit tests, Java input parser and two bugs. Do not add coverage percentages, CI integration, deployment or a team role.",
  },
  {
    id: "resume-content",
    kind: "resume",
    posting:
      "Write and maintain concise community announcements and keep content consistent across channels.",
    question: "Tailor this resume bullet for the posting.",
    limit: 28,
    facts: [
      "Edited 6 event announcements for a neighborhood newsletter and checked the published dates against the venue calendar.",
    ],
    rubric:
      "Retain 6 announcements, the neighborhood newsletter and date verification. Do not claim authorship, social-channel publishing or audience growth.",
  },
];
