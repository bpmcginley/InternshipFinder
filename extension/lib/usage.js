// AI cost meter. Kept under its own storage key ("usage") so it never races the big store write.
// Prices are USD per million tokens and editable in Deep Dive → Setup (the defaults are estimates).
export const DEFAULT_PRICES = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
  "gemini-3.8-flash": { in: 0.5, out: 3 },
};
const KEY = "usage";
let lock = Promise.resolve();

export const monthKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);

export async function loadUsage() {
  const u = (await chrome.storage.local.get(KEY))[KEY] || {};
  return { months: u.months || {}, prices: u.prices || {}, budget: +u.budget || 0 };
}

export async function saveUsage(patch) {
  const u = await loadUsage();
  await chrome.storage.local.set({ [KEY]: { ...u, ...patch } });
}

export function priceFor(model, overrides = {}) {
  const base = DEFAULT_PRICES[model] || (String(model).startsWith("gemini") ? DEFAULT_PRICES["gemini-3.8-flash"] : DEFAULT_PRICES["claude-sonnet-5"]);
  return { ...base, ...(overrides[model] || {}) };
}

// Anthropic and Gemini report usage differently; map both to one shape.
export function tokens(model, u) {
  if (!u) return { input: 0, output: 0, cache_write: 0, cache_read: 0 };
  if (String(model).startsWith("gemini")) {
    const cached = u.cachedContentTokenCount || 0;
    return { input: (u.promptTokenCount || 0) - cached, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), cache_write: 0, cache_read: cached };
  }
  return { input: u.input_tokens || 0, output: u.output_tokens || 0, cache_write: u.cache_creation_input_tokens || 0, cache_read: u.cache_read_input_tokens || 0 };
}

export function costOf(model, usage, overrides) {
  const p = priceFor(model, overrides);
  const t = tokens(model, usage);
  return (t.input * p.in + t.cache_write * p.in * 1.25 + t.cache_read * p.in * 0.1 + t.output * p.out) / 1e6;
}

// Adds one call to this month's totals and returns its cost.
export function recordUsage(model, usage, kind = "other") {
  const p = lock.then(async () => {
    const u = await loadUsage();
    const cost = costOf(model, usage, u.prices);
    const t = tokens(model, usage);
    const m = u.months[monthKey()] || { usd: 0, calls: 0, input: 0, output: 0, by_kind: {} };
    m.usd += cost; m.calls++; m.input += t.input + t.cache_write + t.cache_read; m.output += t.output;
    m.by_kind[kind] = (m.by_kind[kind] || 0) + cost;
    u.months[monthKey()] = m;
    await chrome.storage.local.set({ [KEY]: u });
    return cost;
  });
  lock = p.catch(() => {});
  return p;
}

export async function spend() {
  const u = await loadUsage();
  const m = u.months[monthKey()] || { usd: 0, calls: 0 };
  return { month_usd: m.usd, calls: m.calls, budget: u.budget, over: u.budget > 0 && m.usd >= u.budget };
}

// Average cost of applications that got to the review step.
export function perApplication(jobs) {
  const done = jobs.filter((j) => j.cost_usd > 0 && ["ready_to_submit", "submitted"].includes(j.status));
  return done.length ? done.reduce((a, j) => a + j.cost_usd, 0) / done.length : 0;
}

export const money = (n) => (!n ? "$0" : n < 0.01 ? "<$0.01" : "$" + n.toFixed(2));
