export const SLOTS = [
  ["resume", "Resume", "Required. Used for every application and uploaded where asked."],
  ["cv", "CV", "Optional longer version with everything."],
  ["transcript", "Transcript", "Optional. Uploaded when a site asks for one."],
  ["cover_letter", "Cover letter", "Optional. A past letter you like, used as a style reference and uploaded if asked."],
];

const YN = ["", "Yes", "No"];
export const FACTS = [
  ["Contact", "", [
    ["first_name", "First name"], ["last_name", "Last name"], ["preferred_name", "Preferred name"], ["pronouns", "Pronouns"],
    ["email", "Email"], ["phone", "Phone"], ["address", "Street address"], ["city", "City"], ["state", "State"], ["zip", "ZIP"],
    ["country", "Country"], ["linkedin", "LinkedIn URL"], ["github", "GitHub URL"], ["website", "Website / portfolio"]]],
  ["Work eligibility", "", [
    ["work_authorized", "Authorized to work in the US?", YN],
    ["needs_sponsorship", "Need visa sponsorship now or later?", YN],
    ["citizenship", "Citizenship", ["", "U.S. citizen", "U.S. permanent resident", "F-1 student visa", "Other"]],
    ["clearance_eligible", "Eligible for a security clearance?", ["", "Yes", "No", "Not sure"]],
    ["over_18", "18 or older?", YN], ["background_check", "OK with a background check?", YN],
    ["drug_test", "OK with a drug test?", YN], ["non_compete", "Bound by a non-compete?", YN]]],
  ["Availability and defaults", "", [
    ["available_start", "Internship start date (e.g. May 2027)"], ["available_end", "Internship end date (e.g. August 2027)"],
    ["earliest_start", "Earliest start date"], ["hours_per_week", "Hours per week"],
    ["willing_to_relocate", "Willing to relocate for the summer?", YN], ["willing_to_travel", "Willing to travel?", YN],
    ["salary_expectation", "Pay expectation (blank = \"flexible\")"], ["how_heard", "\"How did you hear about us?\" default"],
    ["worked_here_before", "\"Worked here before?\" default", YN], ["languages", "Languages you speak"]]],
  ["Voluntary self-identification", "These questions are optional and can't affect your eligibility. The default is to decline.", [
    ["gender", "Gender", ["Decline to self-identify", "Male", "Female", "Non-binary"]],
    ["hispanic", "Hispanic or Latino?", ["Decline to self-identify", "Yes", "No"]],
    ["race", "Race", ["Decline to self-identify", "American Indian or Alaska Native", "Asian", "Black or African American", "Native Hawaiian or Other Pacific Islander", "White", "Two or more races"]],
    ["veteran", "Veteran status", ["I don't wish to answer", "I am not a protected veteran", "I identify as one or more of the classifications of protected veteran"]],
    ["disability", "Disability", ["I don't wish to answer", "No, I do not have a disability", "Yes, I have a disability (or previously had one)"]],
    ["lgbtq", "LGBTQ+?", ["Decline to self-identify", "Yes", "No"]]]],
];

export const VOICE_FIELDS = [
  ["summary", "In a sentence, how you come across"], ["tone", "Tone"], ["sentence_style", "Sentence style"],
  ["vocabulary", "Word choice"], ["avoid", "Things to avoid"], ["sample", "A sample answer in your voice"],
];

export const JSON_SECTIONS = [
  ["education", "Education"], ["experience", "Experience"], ["projects", "Projects"],
  ["skills", "Skills"], ["links", "Links"], ["stories", "Stories"], ["extra", "Answers learned while applying"],
];
export const GOAL_FIELDS = [
  ["career", "Career goals"], ["why_field", "Why this field"], ["why_internship", "What you want from an internship"],
  ["interests", "Interests"], ["strengths", "Strengths"], ["growth_areas", "Growth areas"],
];
