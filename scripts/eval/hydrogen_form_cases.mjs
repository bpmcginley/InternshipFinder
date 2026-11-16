const field = (ref, label, options = {}) => ({
  ref,
  label,
  kind: "text",
  required: true,
  ...options,
});
const select = (ref, label, options = ["Yes", "No"]) =>
  field(ref, label, { kind: "select", options });
const value = (ref, answer, critical = false) => ({ ref, value: answer, critical });
const next = { ref: "next", text: "Save and Continue" };
const submit = { ref: "submit", text: "Submit application", blocked: true };
const page = (fields, expected, options = {}) => ({
  fields,
  expected,
  buttons: [options.final ? submit : next],
  ...options.extra,
});
const review = () =>
  page(
    [field("review-email", "Email address", { value: "jordan.rivera@example.com" })],
    [value("review-email", "jordan.rivera@example.com")],
    { final: true, extra: { review: true } },
  );

const longPosting = `Example Data Systems is offering a fictional software engineering internship on the
Data Reliability team. The team maintains internal services that help support staff and analysts
understand whether scheduled loads arrived on time, passed validation, and became available to
internal dashboards. The role is a full-time summer placement in Chicago. Interns can expect to
spend the first two weeks becoming comfortable with the codebase, meeting their mentor, and observing
an ordinary on-call handoff. They will have a defined project with a demo at the end of the placement.

The intern's project will improve the way analysts identify which nightly file needs a closer look.
Today an analyst can see whether a batch passed overall but must open several screens to determine
which input was stale or did not match its expected format. The intern will work with a mentor to
document the existing workflow, compare the checks already available to the team, and propose a small
set of changes that can be delivered without changing every pipeline at once. The project may include
adding a validation rule, improving the metadata attached to a failure, or making the error summary
easier for a non-engineer to interpret.

The codebase uses Python for scheduled processing and SQL for validation and reporting. The intern
will read test fixtures, add cases that demonstrate a change, and write short notes explaining when
a new rule should run. Typical tasks include adding a check for missing columns, identifying which
file arrived late, and documenting the difference between a temporary data delay and a permanent
validation failure. Existing tests use synthetic data. The mentor will explain how test fixtures
are generated, which parts of the pipeline are out of scope for the project, and how to request
a review from the engineer who owns the integration.

Part of the project involves writing a lightweight status summary that analysts can use during their
morning review. The intern will ask one analyst to describe their normal process, identify the few
facts the summary must show, and bring an early draft to a feedback session. The draft should make
it clear what the underlying checks found and identify which results need another look. The intern
will be encouraged to revise the first draft after an analyst tries it and to explain what they
changed in response. Existing dashboards are maintained by a separate team, and the project should
work within the team's current access and publishing process.

Code reviews happen throughout the placement. A typical review asks the author to show which problem
they tested, how they know the behavior is correct, and what operational detail a future maintainer
should know. The team prefers straightforward naming, small pull requests, and tests that represent
what actually goes wrong. The intern will also practice explaining their work to a mixed audience,
using a short demo and documentation that another engineer can use to repeat the verification.

Required background includes coursework or project work involving programming and a willingness to
learn SQL. The team welcomes experience from classes, personal projects, or prior jobs. Experience
working with relational data, testing a small service, or explaining a technical result to someone
outside engineering can be helpful. Applicants can describe work that is still in progress if they
make clear what they personally completed. Prior industry experience is optional. The team does not
require a specific prior employer or school. The project may be adjusted after the mentor and intern
agree on which part is appropriate for the length of the placement.

The application asks for a resume, a few structured answers about availability and education, and
one short response describing relevant work. Applicants may use an example from a project, class,
or job. Useful details include what the applicant owned, what was measured, and what they would do
next. The final submission is the applicant's responsibility. The team reviews responses after the
deadline and contacts selected applicants to arrange an interview.`;

export const formCases = [
  {
    id: "education-and-contact",
    pages: [
      page(
        [
          field("first", "Legal first name"),
          field("last", "Legal last name"),
          field("city", "Current city"),
        ],
        [value("first", "Jordan"), value("last", "Rivera"), value("city", "Springfield")],
      ),
      page(
        [
          field("school", "College or university"),
          select("major", "Primary field of study", ["Business", "Computer Science", "Statistics"]),
          select("graduation", "Anticipated graduation year", ["2027", "2028", "2029"]),
        ],
        [
          value("school", "Example State University"),
          value("major", "Computer Science"),
          value("graduation", "2028"),
        ],
        { final: true },
      ),
    ],
  },
  {
    id: "work-history-and-upload",
    pages: [
      page(
        [
          field("employer", "Employer for your most recent software engineering internship"),
          field("position", "Title for that internship"),
          field("portfolio", "GitHub profile URL", { type: "url" }),
        ],
        [
          value("employer", "Northwind Analytics"),
          value("position", "Software Engineering Intern"),
          value("portfolio", "https://example.com/gh/jrivera"),
        ],
      ),
      page([field("cv", "Attach your resume or CV", { kind: "file" })], [value("cv", "resume")], {
        final: true,
      }),
    ],
  },
  {
    id: "availability-and-validation",
    pages: [
      page(
        [
          field("from", "First day you are available to work", {
            type: "date",
            error: "Enter a date in YYYY-MM-DD format",
          }),
          field("through", "Last day you are available to work", { type: "date" }),
        ],
        [value("from", "2027-05-24", true), value("through", "2027-08-13", true)],
      ),
      page(
        [
          select("relocation", "Would you relocate for this internship if needed?"),
          field("zip", "Current ZIP code", { maxlength: 5 }),
        ],
        [value("relocation", "Yes", true), value("zip", "62701")],
        { final: true },
      ),
    ],
  },
  {
    id: "independent-eligibility",
    facts: {
      work_authorized: "Yes",
      needs_sponsorship: "Yes",
      citizenship: "",
      clearance_eligible: "",
    },
    pages: [
      page(
        [
          select(
            "authorized",
            "Are you currently legally authorized to work in the United States?",
          ),
        ],
        [value("authorized", "Yes", true)],
      ),
      page(
        [
          select(
            "sponsor",
            "Will you now or in the future require visa sponsorship to work in the US?",
          ),
        ],
        [value("sponsor", "Yes", true)],
        { final: true },
      ),
    ],
  },
  {
    id: "missing-required-authorization",
    facts: { citizenship: "", clearance_eligible: "" },
    unconfirmed: ["work_authorized"],
    pages: [
      page(
        [
          field("email", "Email", { type: "email" }),
          field("state", "Current state (two-letter abbreviation)"),
        ],
        [value("email", "jordan.rivera@example.com"), value("state", "IL")],
      ),
      page(
        [select("auth", "Are you legally authorized to work in the United States?")],
        [value("auth", "", true)],
        {
          final: true,
          extra: { ask: /authoriz|eligible to work|right to work/i },
        },
      ),
    ],
  },
  {
    id: "optional-disclosure-and-review",
    pages: [
      page(
        [
          field("last", "Last name", { value: "Rivera" }),
          field("license", "If you hold a current commercial driver's license, enter its class", {
            required: false,
          }),
          select("vet", "Veteran status", [
            "Protected veteran",
            "Not a protected veteran",
            "I don't wish to answer",
          ]),
        ],
        [
          value("last", "Rivera"),
          value("license", "", true),
          value("vet", "I don't wish to answer", true),
        ],
      ),
      review(),
    ],
  },
  {
    id: "long-posting-and-grounded-answer",
    description: longPosting,
    pages: [
      page(
        [
          field("email", "Contact email", { value: "jordan.rivera@example.com" }),
          field("github", "GitHub profile URL", { type: "url" }),
        ],
        [
          value("email", "jordan.rivera@example.com"),
          value("github", "https://example.com/gh/jrivera"),
        ],
      ),
      page(
        [
          field(
            "validation",
            "Describe work where you improved the reliability of incoming data. Include what you did and one measured outcome. Limit 350 characters.",
            { kind: "textarea", maxlength: 350 },
          ),
        ],
        [],
        { final: true, extra: { prose: { ref: "validation", max: 350 } } },
      ),
    ],
  },
  {
    id: "disability-choice-and-education",
    pages: [
      page(
        [
          select("self-id", "Voluntary disability self-identification", [
            "Yes, I have a disability",
            "No, I do not have a disability",
            "I don't wish to answer",
          ]),
          field("school", "Name of the university you currently attend"),
        ],
        [
          value("self-id", "I don't wish to answer", true),
          value("school", "Example State University"),
        ],
      ),
      page(
        [
          field("gpa", "Cumulative GPA on a 4.0 scale"),
          select("minor", "Declared minor", ["None", "Economics", "Statistics"]),
        ],
        [value("gpa", "3.6"), value("minor", "Statistics")],
        { final: true },
      ),
    ],
  },
];
