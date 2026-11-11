// Conservative factual anchors, not a semantic truthfulness classifier. Only true spelling
// aliases share an identity: related technologies (C#/.NET, SQL/Postgres) are not equivalents.
const technologies = [
  /\bpython\b/i,
  /\bkubernetes\b|\bk8s\b/i,
  /\bjava\b/i,
  /\bjavascript\b|\bjs\b/i,
  /\btypescript\b/i,
  /\bpostgres(?:ql)?\b/i,
  /\bmysql\b/i,
  /\bsqlite\b/i,
  /\baws\b|\bamazon web services\b/i,
  /\bazure\b/i,
  /\bgcp\b|\bgoogle cloud(?: platform)?\b/i,
  /\bdocker\b/i,
  /\btensorflow\b/i,
  /\bpytorch\b/i,
  /(?<![\w+#])c\+\+(?![\w+#])/i,
  /(?<![\w+#])c#(?![\w+#])/i,
  /(?<![\w.])\.net\b/i,
  /\bnode(?:\.js|js)\b/i,
];
const units = [
  ["percentage-point", /^(?:percentage|percent)[ \t]+points?\b/i],
  ["percent", /^(?:%|percent\b|per[ \t]+cent\b)/i],
  ["usd", /^(?:USD\b|US\$)/i],
  ["eur", /^(?:EUR\b|euros?\b|€)/i],
  ["gbp", /^(?:GBP\b|£)/i],
  ["dollar", /^(?:dollars?\b|\$)/i],
  ["hour", /^(?:hours?|hrs?)\b/i],
  ["minute", /^(?:minutes?|mins?)\b/i],
  ["second", /^(?:seconds?|secs?)\b/i],
  ["day", /^days?\b/i],
  ["week", /^(?:weeks?|wks?)\b/i],
  ["month", /^(?:months?|mos?)\b/i],
  ["year", /^(?:years?|yrs?)\b/i],
];
const currency = {
  usd: "usd",
  us$: "usd",
  eur: "eur",
  "€": "eur",
  gbp: "gbp",
  "£": "gbp",
  $: "dollar",
};
// The 8 in the true Kubernetes alias is not a resume metric. Other numbers keep their exact form.
const quantityText = (text) => String(text || "").replace(/\bk8s\b/gi, "Kubernetes");
export const numbersIn = (text) => quantityText(text).match(/\d+(?:[.,]\d+)*/g) || [];
const magnitudes = { thousand: "k", k: "k", million: "m", m: "m", billion: "b", b: "b" };
const moneyUnits = new Set(Object.values(currency));
const timeUnits = units.filter(([unit]) =>
  ["hour", "minute", "second", "day", "week", "month", "year"].includes(unit),
);
function quantities(raw) {
  const text = quantityText(raw),
    out = [];
  for (const m of text.matchAll(
    /(?:(?<!\w)([+-])?(USD|US\$|EUR|€|GBP|£|\$)[ \t]*)?([+-])?(\d+(?:[.,]\d+)*)/gi,
  )) {
    const after = text.slice(m.index + m[0].length).replace(/^[ \t]*(?:-[ \t]*)?/, "");
    const magnitude = /^(thousand|million|billion|k|m|b)\b[ \t]*/i.exec(after);
    let suffix = magnitude ? after.slice(magnitude[0].length) : after;
    let matched = units.find(([, re]) => re.test(suffix));
    let unit = m[2] ? currency[m[2].toLowerCase()] : matched?.[0] || "bare";
    const money = moneyUnits.has(unit);
    // Short magnitudes require a currency: m never silently becomes million minutes/months.
    const scale =
      magnitude && (money || magnitude[1].length > 1) ? magnitudes[magnitude[1].toLowerCase()] : "";
    if (magnitude && !scale) {
      suffix = after;
      matched = units.find(([, re]) => re.test(suffix));
      unit = matched?.[0] || "bare";
    }
    const rest = matched ? suffix.slice(matched[1].exec(suffix)[0].length) : suffix;
    const rate = /^[ \t]*(?:\/|per[ \t]+)[ \t]*/i.exec(rest);
    const period = rate && timeUnits.find(([, re]) => re.test(rest.slice(rate[0].length)))?.[0];
    // Only explicit monetary/percentage signs and slash/per time rates are interpreted here.
    // Date-range hyphens, ordinary prose and implied causality remain outside this check.
    const sign = (money || unit.startsWith("percent")) && (m[1] === "-" || m[3] === "-") ? "-" : "";
    out.push(`${sign}${m[4]}:${unit}:${scale}:${period || ""}`);
  }
  return out;
}

// Source arrays keep unrelated entries separate; a number at one entry's end cannot borrow
// a unit from the next. Callers choose the mapped bullet/paragraph, or factual summary inputs.
export function hasUnsupportedAnchors(next, source) {
  const sources = (Array.isArray(source) ? source : [source]).map((s) => String(s || ""));
  const text = String(next || "");
  const known = new Set(sources.flatMap(quantities));
  return (
    quantities(text).some((q) => !known.has(q)) ||
    technologies.some((term) => term.test(text) && !sources.some((s) => term.test(s)))
  );
}
