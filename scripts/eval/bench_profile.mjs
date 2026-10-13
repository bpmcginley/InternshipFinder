// The fictional student the offline form benchmark (form_bench.mjs) applies as. Nobody real: every
// name, number and link here is made up, and the links all point at example.com. Built on the
// extension's own emptyStore(), so the profile has exactly the shape a finished Deep Dive leaves
// behind and profileForModel() turns it into the same JSON production sends.
globalThis.chrome = globalThis.chrome || { runtime: {}, storage: { local: {}, session: {} }, tabs: {}, scripting: {} };
const { emptyStore } = await import("../../extension/lib/store.js");

// A one-page PDF that says what it is. Big enough to be a real file, small enough to keep in memory.
const RESUME_PDF = "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n" +
  "4 0 obj<</Length 60>>stream\nBT /F1 14 Tf 72 720 Td (Jordan Rivera - fictional resume) Tj ET\nendstream endobj\n" +
  "5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n";

export const RESUME_FILE = { name: "Jordan_Rivera_Resume.pdf", type: "application/pdf", b64: Buffer.from(RESUME_PDF).toString("base64"), size: RESUME_PDF.length };

export function benchStore() {
  const s = emptyStore();
  Object.assign(s.profile.facts, {
    first_name: "Jordan", last_name: "Rivera", preferred_name: "", pronouns: "he/him",
    email: "jordan.rivera@example.com", phone: "(555) 010-4477",
    address: "100 Example Ave, Apt 4", city: "Springfield", state: "IL", zip: "62701", country: "United States",
    linkedin: "https://example.com/in/jordan-rivera", github: "https://example.com/gh/jrivera", website: "https://jordanrivera.example.com",
    work_authorized: "Yes", needs_sponsorship: "No", citizenship: "U.S. citizen", clearance_eligible: "Yes",
    willing_to_relocate: "Yes", available_start: "May 24, 2027", available_end: "August 13, 2027", earliest_start: "May 24, 2027",
    hours_per_week: "40", salary_expectation: "$25/hour", how_heard: "Online job board",
    worked_here_before: "No", languages: "English (native), Spanish (conversational)", willing_to_travel: "Yes",
    over_18: "Yes", background_check: "Yes", drug_test: "Yes", non_compete: "No",
    gender: "Decline to self-identify", race: "Decline to self-identify", hispanic: "Decline to self-identify",
    veteran: "I don't wish to answer", disability: "I don't wish to answer", lgbtq: "Decline to self-identify",
    majors: "Computer Science", class_year: "2028", grad_term: "Spring 2028",
  });
  s.profile.education = [{
    school: "Example State University", degree: "Bachelor of Science", major: "Computer Science", minor: "Statistics",
    gpa: "3.6", start: "Aug 2024", end: "May 2028", grad_term: "May 2028",
    coursework: "Data Structures, Algorithms, Databases, Machine Learning, Probability and Statistics, Linear Algebra, Principles of Microeconomics",
  }];
  s.profile.experience = [
    { company: "Northwind Analytics", title: "Software Engineering Intern", location: "Chicago, IL", start: "Jun 2026", end: "Aug 2026",
      bullets: ["Built a Python service that validates nightly client data loads, catching about 40 bad files a month before they reached reports",
        "Added PostgreSQL indexes and query rewrites that cut the slowest dashboard query from 9 s to 1.2 s",
        "Wrote unit tests (pytest) for a legacy ETL module, raising its coverage from 20% to 75%"] },
    { company: "Example State University IT Help Desk", title: "Student IT Technician", location: "Springfield, IL", start: "Sep 2024", end: "Present",
      bullets: ["Resolve 25+ hardware, network and account tickets a week for students and staff",
        "Wrote a PowerShell script that automated lab-machine imaging, saving about 6 staff hours a week"] },
  ];
  s.profile.projects = [
    { name: "CampusEats", role: "Lead developer (team of 3)", dates: "Jan 2026 - Apr 2026",
      description: "React Native and Flask app that shows dining-hall menus and wait times; about 1,200 students used it in its first semester. I designed the REST API and the PostgreSQL schema.",
      link: "https://example.com/gh/jrivera/campuseats" },
    { name: "Course grade predictor", role: "Solo project for Machine Learning class", dates: "Oct 2025 - Dec 2025",
      description: "Trained scikit-learn models on an anonymized course dataset to flag students at risk of failing by week 5; gradient boosting reached 0.81 AUC. Wrote up the bias checks I ran.",
      link: "https://example.com/gh/jrivera/grade-predictor" },
  ];
  s.profile.skills = {
    technical: ["Python", "Java", "JavaScript", "TypeScript", "SQL", "React", "React Native", "Flask", "pandas", "scikit-learn"],
    tools: ["Git", "Docker", "AWS (EC2, S3)", "PostgreSQL", "Linux", "Excel", "Tableau"],
    soft: ["Clear written communication", "Teaching and explaining", "Working on small teams"],
  };
  s.profile.links = [
    { label: "LinkedIn", url: "https://example.com/in/jordan-rivera" },
    { label: "GitHub", url: "https://example.com/gh/jrivera" },
    { label: "Portfolio", url: "https://jordanrivera.example.com" },
  ];
  s.profile.stories = [
    { theme: "Ownership / fixing a real problem", situation: "At Northwind Analytics, bad client files kept breaking the morning reports.",
      task: "Find a way to catch them before the reports ran.", action: "Wrote a Python validation service with schema and range checks, and an alert to the on-call analyst.",
      result: "About 40 bad files a month were caught before reaching reports; the team kept using it after I left.", reflection: "Talking to the analysts first told me which checks mattered." },
    { theme: "Teamwork / shipping under a deadline", situation: "CampusEats had to launch before the spring semester's second week.",
      task: "Get a working app to students with a team of three part-time developers.", action: "Split the work by API, mobile and data, set up CI, and cut features that weren't needed for launch.",
      result: "Launched on time; 1,200 students used it that semester.", reflection: "Cutting scope early was the decision that made the date." },
  ];
  s.profile.goals = {
    career: "Become a software engineer working on data-heavy products and the infrastructure behind machine learning.",
    why_field: "I like building tools people use every day, and data problems are where I learn fastest.",
    interests: "Developer tools, fintech, climate and energy software, data engineering",
    strengths: "Turning messy data into reliable systems; explaining technical work plainly",
    growth_areas: "Distributed systems at scale; public speaking",
    why_internship: "I want to ship production code on a real team and learn how larger systems are run.",
  };
  s.profile.voice = {
    summary: "Plain and direct; concrete examples over adjectives.", tone: "Friendly, confident, not salesy",
    sentence_style: "Short to medium sentences, first person", vocabulary: "Everyday words; technical terms only when needed",
    avoid: "Buzzwords like 'passionate', 'synergy', 'leverage'; exclamation marks", sample: "",
  };
  s.files.resume = { ...RESUME_FILE };
  s.settings.signup_email = "jordan.rivera@example.com";
  s.settings.onboarded = true;
  return s;
}
