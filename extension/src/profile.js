// Default profile schema. Edit values in the extension's Options page.
// Stored in chrome.storage.local under key "internscout".
const DEFAULT_PROFILE = {
  first_name: "",
  last_name: "",
  full_name: "",
  email: "",
  phone: "",
  city: "",              // e.g. "Boston, MA"
  country: "United States",
  address_line1: "",
  city_only: "",
  state: "",
  postal_code: "",
  resume_text: "",       // paste resume text; grounds AI answers
  linkedin: "",
  github: "",
  website: "",
  school: "",
  degree: "",            // e.g. "B.S. Computer Science"
  major: "",
  grad_term: "",         // e.g. "May 2027"
  gpa: "",
  work_authorized: "Yes",     // authorized to work in the US?
  needs_sponsorship: "No",    // require visa sponsorship?
  how_heard: "Company website",
  // Free-text: background used to ground AI answers, plus canned fallbacks.
  background: "",        // 3-6 sentences about you, used in AI prompts
  templates: {
    // label keyword -> canned text (used when AI is off). {{company}} is substituted.
    "why": "I'm excited about {{company}} because the work aligns closely with my background in software and quantitative problem-solving, and I'm eager to contribute and learn from a strong team."
  }
};
const AI_DEFAULTS = { apiKey: "", model: "claude-haiku-4-5-20251001", provider: "anthropic" };

function loadStore() {
  return new Promise((res) => {
    chrome.storage.local.get(["internscout", "ai"], (d) => {
      res({
        profile: Object.assign({}, DEFAULT_PROFILE, d.internscout || {}),
        ai: Object.assign({}, AI_DEFAULTS, d.ai || {})
      });
    });
  });
}
