// Service worker: routes AI requests to the Anthropic API using the user's own key.
// Runs here (not the content script) to keep the key out of the page and satisfy CORS.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "ai") {
    handleAi(msg).then((text) => sendResponse({ text })).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg.type === "map_fields") {
    mapFields(msg).then((fills) => sendResponse({ fills })).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
});

// AI form mapper: given the profile + a DOM field list, decide what to enter in each field.
// This is what lets autofill work on ANY site, not just preprogrammed ATS platforms.
async function mapFields({ fields, profile, ai }) {
  if (!ai.apiKey) throw new Error("No API key set (Options page).");
  const sys =
    "You map a job-application form to a candidate's saved profile. You are given PROFILE " +
    "(key/value facts) and FIELDS (each has idx, label, type, and options for dropdowns). " +
    "For each field, decide the value to enter using ONLY the profile — never invent facts. " +
    "For dropdowns, return the exact option text that best matches (or your best guess of the " +
    "option label if options are not provided). For a work-authorization question use " +
    "profile.work_authorized; for a visa/sponsorship question use profile.needs_sponsorship. " +
    "Skip (omit) any field you have no profile data for, or that is sensitive/ambiguous " +
    "(demographics, EEO, veteran/disability, signatures, passwords). " +
    'Return ONLY minified JSON: {"fills":[{"idx":<int>,"value":"<string>"}]}';
  const profileForAi = {};
  for (const [k, v] of Object.entries(profile || {})) {
    if (["templates", "resume_text", "files"].includes(k)) continue;
    if (v) profileForAi[k] = v;
  }
  const user = `PROFILE:\n${JSON.stringify(profileForAi)}\n\nFIELDS:\n${JSON.stringify(fields).slice(0, 12000)}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ai.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: ai.model || "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      system: sys,
      messages: [{ role: "user", content: user }]
    })
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`${res.status} ${t.slice(0, 200)}`); }
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || "").join("");
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("No JSON in response");
  const parsed = JSON.parse(text.slice(a, b + 1));
  return Array.isArray(parsed.fills) ? parsed.fills : [];
}

async function handleAi({ question, company, jd, profile, ai }) {
  if (!ai.apiKey) throw new Error("No API key set (Options page).");
  const sys = "You help a candidate draft a concise, specific, honest answer to a job " +
    "application question. 90-150 words. First person. No clichés or fabricated experience. " +
    "Ground it in the candidate background and the role. Return only the answer text.";
  const user = `Company: ${company}
Question: ${question}

Candidate background:
${profile.background || ""}

Resume:
${(profile.resume_text || "").slice(0, 3000) || `${profile.degree || ""} in ${profile.major || ""}.`}

Role / job description (excerpt):
${(jd || "").slice(0, 4000)}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ai.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: ai.model || "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system: sys,
      messages: [{ role: "user", content: user }]
    })
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${res.status} ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = (data.content || []).map((c) => c.text || "").join("").trim();
  if (!text) throw new Error("Empty response");
  return text;
}
