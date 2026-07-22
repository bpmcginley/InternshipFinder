// Maps a form field's visible label/attributes to a profile key. Works across
// Greenhouse and Lever because it keys off human-readable label text, not fixed selectors.
function fieldLabelText(el) {
  let parts = [];
  if (el.id) {
    const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (lab) parts.push(lab.textContent);
  }
  const wrapLabel = el.closest("label");
  if (wrapLabel) parts.push(wrapLabel.textContent);
  if (el.getAttribute("aria-label")) parts.push(el.getAttribute("aria-label"));
  if (el.placeholder) parts.push(el.placeholder);
  if (el.name) parts.push(el.name);
  if (el.id) parts.push(el.id);
  // nearby label in a question card (Lever/Greenhouse custom questions)
  const card = el.closest(".application-question, .field, .form-field, li, div");
  if (card) {
    const lbl = card.querySelector("label, .application-label, .text");
    if (lbl) parts.push(lbl.textContent);
  }
  return parts.join(" ").toLowerCase().replace(/\s+/g, " ").trim();
}

// Ordered rules: first match wins. Returns a profile key or null.
const RULES = [
  [/first name|given name/, "first_name"],
  [/last name|family name|surname/, "last_name"],
  [/full name|^name$|\byour name\b|legal name/, "full_name"],
  [/e-?mail/, "email"],
  [/phone|mobile|telephone/, "phone"],
  [/linkedin/, "linkedin"],
  [/github/, "github"],
  [/portfolio|personal (web)?site|website|url/, "website"],
  [/school|university|college|institution/, "school"],
  [/degree/, "degree"],
  [/major|field of study|discipline|concentration/, "major"],
  [/graduat/, "grad_term"],
  [/gpa/, "gpa"],
  [/city|current location|where are you (based|located)|location/, "city"],
  [/authoriz.*(work|employ)|(work|employ).*authoriz|legally authorized|eligible to work/, "work_authorized"],
  [/sponsor/, "needs_sponsorship"],
  [/how did you hear|referral source|how you heard/, "how_heard"],
  [/country|nationality/, "country"]
];

function matchProfileKey(labelText) {
  for (const [re, key] of RULES) if (re.test(labelText)) return key;
  return null;
}

// Heuristic: is this free-text field an open-ended question (AI-worthy)?
function looksLikeQuestion(labelText) {
  return labelText.includes("?") ||
    /why|describe|tell us|explain|what (are|is|do)|cover letter|interest|motivat/.test(labelText);
}
