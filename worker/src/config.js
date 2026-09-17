// Server-side knobs. Clients never pick the model or the limits. Edit, then `wrangler deploy`.

// Current stable models, paid tier (ai.google.dev/gemini-api/docs/models, checked 2026-09-14)
export const FLASH = "gemini-3.8-flash";
export const FLASH_LITE = "gemini-3.5-flash-lite";

// Per task: model, output-token ceiling, thinking ceiling, monthly allowance in units (runs)
export const TASKS = {
  field_match:   { model: FLASH_LITE, maxOutputTokens: 1024, thinkingLevel: "minimal", thinkingBudget: 0,    allowance: 200 },
  short_answer:  { model: FLASH_LITE, maxOutputTokens: 2048, thinkingLevel: "low",     thinkingBudget: 1024, allowance: 60 },
  resume_tailor: { model: FLASH,      maxOutputTokens: 8192, thinkingLevel: "medium",  thinkingBudget: 4096, allowance: 8 },
  autofill:      { model: FLASH,      maxOutputTokens: 4096, thinkingLevel: "low",     thinkingBudget: 2048, allowance: 15 },
  deep_dive:     { model: FLASH,      maxOutputTokens: 8192, thinkingLevel: "medium",  thinkingBudget: 4096, allowance: 2 },
};

// Thinking levels each model accepts, lowest first (ai.google.dev/gemini-api/docs/thinking)
export const THINKING_LEVELS = {
  "gemini-3.8-flash": ["low", "medium", "high"],
  "gemini-3.5-flash-lite": ["minimal", "low", "medium", "high"],
};

// USD per 1M tokens, paid tier (ai.google.dev/gemini-api/docs/pricing, checked 2026-09-14).
// "output" includes thinking tokens; "cached" is the context-cache read price.
// A row with `until` applies before that date (UTC).
export const PRICES = {
  "gemini-3.8-flash": [
    { until: "2027-01-01", input: 0.75, output: 3.75, cached: 0.075 },
    { input: 1.5, output: 7.5, cached: 0.15 },
  ],
  "gemini-3.5-flash-lite": [{ input: 0.3, output: 2.5, cached: 0.03 }],
  "gemini-3.1-flash-lite": [{ input: 0.25, output: 1.5, cached: 0.025 }],
  "gemini-2.5-flash": [{ input: 0.3, output: 2.5, cached: 0.03 }],
  "gemini-2.5-flash-lite": [{ input: 0.1, output: 0.4, cached: 0.01 }],
};
// Unknown model: priced high on purpose so spend is never under-counted
export const FALLBACK_PRICE = { input: 2, output: 12, cached: 0.2 };

// Plans. "free" is everyone; "supporter" is the optional paid plan that exists so AI spend can be
// covered if InternScout gets busy. Its multiplier scales every task allowance in TASKS.
export const PLANS = {
  free: { multiplier: 1 },
  supporter: { multiplier: 4, priceText: "$3/month" },
};

export const CONFIG = {
  TASKS,
  PLANS,
  THINKING_LEVELS,
  PRICES,
  FALLBACK_PRICE,
  MAX_CALLS_PER_RUN: 60,
  // perMinute/perDay are per student. globalPerMinute is the whole deployment: without it, a dozen
  // students working at once can spend the account's entire Gemini RPM, and Google answers everyone
  // with 429s instead of just turning the newest arrivals away. Google no longer publishes a fixed
  // per-tier RPM -- it is account-specific and shown at aistudio.google.com/rate-limit -- so this
  // default is deliberately well under any paid tier. Raise it via the GLOBAL_RPM var once you have
  // read your own number, keeping some headroom.
  RATE: { perMinute: 10, perDay: 300, globalPerMinute: 120 },
  MONTHLY_BUDGET_CENTS: 2500,   // default; the MONTHLY_BUDGET_CENTS var wins
  DEMAND_WINDOW_DAYS: 90,
  MAX_BODY_BYTES: 4_000_000,
  SCOPES: ["openid", "email", "profile"],
  // A Supporter gets a bigger share of the budget than a free student, but still a ceiling: one
  // person on a paid plan must not be able to spend the whole month's budget by themselves.
  SUPPORTER_RATE: { perMinute: 20, perDay: 900 },
};
