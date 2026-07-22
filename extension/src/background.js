// Service worker: routes AI requests to the Anthropic API using the user's own key.
// Runs here (not the content script) to keep the key out of the page and satisfy CORS.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "ai") return;
  handleAi(msg).then((text) => sendResponse({ text })).catch((e) => sendResponse({ error: e.message }));
  return true; // async
});

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
