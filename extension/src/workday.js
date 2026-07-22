// Workday adapter. Workday application forms use stable data-automation-id attributes that
// are consistent across tenant companies, so we target those directly instead of guessing
// from labels. Inputs are React-controlled (native-setter trick applies). Dropdowns are
// Workday's own button+listbox widgets (click button -> click option).
//
// Scope: the "My Information" step (name, contact, address, source) and the common
// work-authorization / sponsorship questions. Multi-step navigation is left to the user.

const WD_TEXT = [
  // [data-automation-id, profileKey]
  ["legalNameSection_firstName", "first_name"],
  ["legalNameSection_lastName", "last_name"],
  ["email", "email"],
  ["phone-number", "phone"],
  ["phoneNumber", "phone"],
  ["addressSection_city", "city_only"],       // Workday wants city alone
  ["address-line-1", "address_line1"],
  ["addressSection_addressLine1", "address_line1"],
  ["postalCode", "postal_code"],
  ["addressSection_postalCode", "postal_code"],
];

// Dropdown questions (Workday listbox): [automationId-contains, value]
const WD_DROPDOWNS = [
  ["country", "country"],
  ["countryRegion", "state"],
  ["source", "how_heard"],
];

function wdSetNative(el, value) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

const wdSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// City helper: strip ", ST" if profile.city is "Boston, MA"
function cityOnly(city) { return (city || "").split(",")[0].trim(); }

async function wdFillDropdown(container, value) {
  const btn = container.querySelector('button, [aria-haspopup="listbox"], [data-automation-id="selectWidget"]') || container;
  btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  btn.click();
  await wdSleep(250);
  const want = String(value).toLowerCase();
  const opts = [...document.querySelectorAll('[data-automation-id="promptOption"], [role="option"]')];
  const opt = opts.find((o) => o.textContent.trim().toLowerCase() === want)
    || opts.find((o) => o.textContent.trim().toLowerCase().includes(want));
  if (!opt) { document.body.click(); return false; }
  opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  opt.click();
  await wdSleep(120);
  return true;
}

async function fillWorkday(profile) {
  let filled = 0, flagged = 0;
  const values = Object.assign({}, profile, {
    city_only: cityOnly(profile.city),
  });
  // text inputs
  for (const [autoId, key] of WD_TEXT) {
    const el = document.querySelector(`input[data-automation-id="${autoId}"], input[data-automation-id*="${autoId}"]`);
    if (!el || el.disabled) continue;
    const val = values[key];
    if (!val) continue;
    if (el.value && el.value.trim()) continue;   // don't clobber prefilled (e.g. account email)
    wdSetNative(el, val);
    filled++;
  }
  // dropdowns (best-effort)
  for (const [idPart, key] of WD_DROPDOWNS) {
    const val = values[key];
    if (!val) continue;
    const container = document.querySelector(`[data-automation-id*="${idPart}"]`);
    if (!container) continue;
    try { if (await wdFillDropdown(container, val)) filled++; else flagged++; }
    catch (e) { flagged++; }
  }
  // Work authorization / sponsorship radio/dropdown groups vary widely by tenant; highlight
  // any Yes/No group so the user completes them.
  document.querySelectorAll('[data-automation-id*="workAuthorization"], [data-automation-id*="sponsor"], [data-automation-id*="Sponsorship"]').forEach((g) => {
    g.style.outline = "2px dashed #f5a623"; flagged++;
  });
  return { filled, flagged };
}
