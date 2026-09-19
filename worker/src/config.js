// Server-side knobs. Clients never pick the model or the limits. Edit, then `wrangler deploy`.

// Current stable models, paid tier (ai.google.dev/gemini-api/docs/models, checked 2026-09-14)
export const FLASH = "gemini-3.8-flash";
export const FLASH_LITE = "gemini-3.5-flash-lite";

// Per task: model, output-token ceiling, thinking ceiling, monthly allowance in units (runs), and the
// largest request body. Only the Deep Dive carries a PDF; the other tasks send text, so a body far
// bigger than they ever build is a modified client, and input tokens are what a call costs.
// An allowance of null means no monthly cap: the rate limits and the budget stop still apply.
export const TASKS = {
  field_match:   { model: FLASH_LITE, maxOutputTokens: 1024, thinkingLevel: "minimal", thinkingBudget: 0,    allowance: 260, maxBodyBytes: 200_000 },
  short_answer:  { model: FLASH_LITE, maxOutputTokens: 2048, thinkingLevel: "low",     thinkingBudget: 1024, allowance: 80, maxBodyBytes: 200_000 },
  resume_tailor: { model: FLASH,      maxOutputTokens: 8192, thinkingLevel: "medium",  thinkingBudget: 4096, allowance: 10, maxBodyBytes: 1_500_000 },
  autofill:      { model: FLASH,      maxOutputTokens: 4096, thinkingLevel: "low",     thinkingBudget: 2048, allowance: 20, maxBodyBytes: 1_500_000 },
  // The Deep Dive is done once and costs a few cents, so it is not capped (Bruce, 2026-09-18). It used
  // to be 2 a month, and the first real one ran out after two interview replies because the extension
  // sent no run_id and every reply counted as its own Deep Dive.
  deep_dive:     { model: FLASH,      maxOutputTokens: 8192, thinkingLevel: "medium",  thinkingBudget: 4096, allowance: null },
};

// Allowances that change on a date (UTC), oldest first; the latest `from` on or before today wins.
// Gemini 3.8 Flash doubles in price on 2027-01-01 (see PRICES), so every Flash task's monthly units
// halve that day and a full month still costs what it did: a Supporter who uses every unit would
// otherwise cost ~$8.70 of AI against $4.56 net. Flash-Lite tasks keep their allowance. The plan
// multipliers apply on top, so the paid tiers halve too. The Deep Dive has no cap, so it is not here.
export const ALLOWANCE_CHANGES = [
  { from: "2027-01-01", tasks: { resume_tailor: 5, autofill: 10 } },
];

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

// A Supporter or Pro gets a bigger share of the budget than a free student, but still a ceiling: one
// person on a paid plan must not be able to spend the whole month's budget by themselves.
const FREE_RATE = { perMinute: 10, perDay: 300 };
const PAID_RATE = { perMinute: 20, perDay: 900 };
const PRO_RATE = { perMinute: 25, perDay: 2000 };

// Plans. "free" is everyone. The paid plans exist so AI spend can be covered if InternScout gets
// busy; a plan's multiplier scales every task allowance in TASKS, and the .edu doubling applies on
// top, so a UMass supporter gets twice what a non-UMass supporter does.
//
// The multipliers are set so a plan still pays for itself even when a .edu student uses every unit
// of it. An auto-filled application is what dominates the bill, at roughly $0.06 of Gemini once the
// rules-first path has skipped the applications that need no model at all; a tailored resume is
// about $0.01 and a Deep Dive about $0.02. Stripe keeps 2.9% + 30c, so at the ceiling:
//   Supporter $5  -> $4.56 net, 50 autofills + 25 resumes + 5 Deep Dives = about $3.35 (27% left)
//   Pro       $12 -> $11.35 net, 120 autofills + 60 resumes + 12 Deep Dives = about $8.04 (29% left)
// Almost nobody empties a month's allowance, so the everyday margin is far wider than that; the
// ceiling is what stops a heavy month from costing more than it brought in. Raising a multiplier
// without raising the price eats it fast: 3x on Supporter is already near break-even.
//
// `priceEnv` names the wrangler secret holding that plan's Stripe Price id. A plan whose secret is
// unset is simply not offered, so one tier can go live before the other.
export const PLANS = {
  // free has no `rate` of its own: it uses CONFIG.RATE below, which the RATE var can override.
  free: { multiplier: 1 },
  supporter: { multiplier: 2.5, priceText: "$5/month", priceEnv: "STRIPE_PRICE_ID", textEnv: "SUPPORTER_PRICE_TEXT", label: "Supporter", rate: PAID_RATE },
  pro: { multiplier: 6, priceText: "$12/month", priceEnv: "STRIPE_PRICE_ID_PRO", textEnv: "PRO_PRICE_TEXT", label: "Pro", rate: PRO_RATE },
};

// What one account may cost in a month, in cents, whatever tasks it is spent on. A full free .edu
// allowance costs about $1.50 and a Deep Dive a few cents more, so these sit well clear of honest use;
// the paid rows stay under what the plan brings in after Stripe's cut ($4.56 and $11.35). A "general"
// free account gets GENERAL_ALLOWANCE_PCT of the free row, like its allowances. This is what bounds a
// task with no unit cap (the Deep Dive): without it one modified client could spend the whole
// MONTHLY_BUDGET_CENTS and pause AI for everyone.
export const USER_BUDGET_CENTS = { free: 300, supporter: 450, pro: 1100 };

// The paid plans, cheapest first. Order is what the dashboard shows.
export const PAID_PLANS = ["supporter", "pro"];

export const CONFIG = {
  TASKS,
  ALLOWANCE_CHANGES,
  PLANS,
  USER_BUDGET_CENTS,
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
  RATE: { ...FREE_RATE, globalPerMinute: 120 },
  MONTHLY_BUDGET_CENTS: 7500,   // default; the MONTHLY_BUDGET_CENTS var wins
  DEMAND_WINDOW_DAYS: 90,
  MAX_BODY_BYTES: 4_000_000,
  SCOPES: ["openid", "email", "profile"],
  PAID_PLANS,
};
