// Alternate prompts and JSON contracts for the whole-resume evaluation.
const FLASH = "gemini-3.8-flash";
const HYDROGEN = "gemini-4-hydrogen";

export const arms = [
  { model: FLASH, level: "medium", id: "flash-medium" },
  { model: HYDROGEN, level: "low", id: "hydrogen-low-standard" },
  { model: HYDROGEN, level: "low", id: "hydrogen-low-structured", prompt: "structured" },
  { model: FLASH, level: "low", id: "flash-low-structured", prompt: "structured" },
  { model: HYDROGEN, level: "low", id: "hydrogen-low-compact", prompt: "compact" },
];
const string = { type: "string" };
const index = { type: "integer", minimum: 0 };
const list = (items) => ({ type: "array", items });
const obj = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const bullet = obj({ from: index, text: string });
const changes = { ...list(string), maxItems: 3 };
const schemas = {
  word: obj({ groups: list(obj({ g: index, bullets: list(bullet) })), changes }),
  "pdf-tailor": obj({
    entries: list(obj({ s: index, e: index, text: string, bullets: list(bullet) }, ["s", "e"])),
    lines: list(obj({ s: index, k: index, text: string })),
    changes,
  }),
  template: obj({
    summary: string,
    experience: list(obj({ i: index, bullets: list(bullet) })),
    projects: list(obj({ i: index, description: string })),
    skills: obj({ technical: list(string), tools: list(string), soft: list(string) }),
    changes,
  }),
};
const foundation =
  "Tailor the resume to the posting. Treat the posting as relevance guidance only. Each edit must be supported by the exact source bullet or paragraph, not other bullets. Keep technologies, quantities, units, ownership, scope and outcomes as stated. If uncertain, keep the original words. Use an action verb and about the original length. Return succinct JSON matching the schema. Changes lists up to three short factual explanations.";
const instructions = {
  word: "Reply only with edited bullet groups, listing every original bullet in each edited group by its index in the desired order. Do not omit any bullet in an edited group. For short skills groups only reorder. Keep every marked span verbatim in its original place. Keep plain text.",
  "pdf-tailor":
    "Rows, headings and other section lines are read-only. Only rewrite supported entry paragraphs and bullets. In each edited bullet list retain every original bullet with its index. Preserve bold/italic marks. In skills lines only reorder the existing items within the same label. In summary lines use only exact evidence elsewhere on the resume.",
  template:
    "List changed experience bullets by their original index and include every original bullet in an edited role. Only rewrite an existing project description with its own evidence. Skill lists can only reorder exactly listed items. An optional one-sentence summary may state only facts directly supported by the profile; use the empty string if uncertain. Keep each bullet under 30 words.",
};
const formatText = {
  word: 'JSON {"groups":[{"g":0,"bullets":[{"from":0,"text":"…"}]}],"changes":[]}',
  "pdf-tailor":
    'JSON {"entries":[{"s":0,"e":0,"text":"…","bullets":[{"from":0,"text":"…"}]}],"lines":[{"s":0,"k":0,"text":"…"}],"changes":[]}',
  template:
    'JSON {"summary":"…","experience":[{"i":0,"bullets":[{"from":0,"text":"…"}]}],"projects":[{"i":0,"description":"…"}],"skills":{"technical":[],"tools":[],"soft":[]},"changes":[]}',
};

export function prepareRewrite(body, phase, mode) {
  if (!mode || phase === "layout") return;
  const rule = mode === "structured" ? foundation : foundation.replace(" matching the schema", "");
  body.systemInstruction.parts[0].text = [rule, instructions[phase]].join(" ");
  if (mode === "structured") {
    body.generationConfig.responseMimeType = "application/json";
    body.generationConfig.responseJsonSchema = schemas[phase];
  } else {
    body.systemInstruction.parts[0].text += " " + formatText[phase];
  }
}
