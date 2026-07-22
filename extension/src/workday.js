// Workday adapter (grounded in a live Workday "My Information" form).
// Reality observed: each field sits in a wrapper [data-automation-id="formField-<name>"].
// Text inputs carry a `name` (e.g. legalName--firstName, addressLine1, city, postalCode,
// email, phoneNumber). Dropdowns are <button> widgets; selecting opens a listbox of
// [data-automation-id="promptOption"] / [role="option"] items. We match on the wrapper id,
// fill text via the native-setter trick, best-effort the dropdowns, and highlight anything
// consequential (Yes/No radios, work auth) for the user.

const WD_RULES = [
  { re: /firstName/i, key: "first_name", kind: "text" },
  { re: /lastName/i, key: "last_name", kind: "text" },
  { re: /(^|-)email/i, key: "email", kind: "text" },
  { re: /phoneNumber|phone-number/i, key: "phone", kind: "text" },
  { re: /addressLine1/i, key: "address_line1", kind: "text" },
  { re: /(^|-)city($|-)/i, key: "city_only", kind: "text" },
  { re: /postalCode|postal-code|zip/i, key: "postal_code", kind: "text" },
  { re: /countryRegion|region|state|province/i, key: "state", kind: "dropdown" },
  { re: /(^|-)country($|-)/i, key: "country", kind: "dropdown" },
  { re: /source/i, key: "how_heard", kind: "dropdown" },
];

const wdSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wdSet(el, value) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}

function cityOnly(city) { return (city || "").split(",")[0].trim(); }
function stateOf(profile) {
  if (profile.state) return profile.state;
  const m = (profile.city || "").split(",")[1];
  return m ? m.trim() : "";
}

async function wdDropdown(wrapper, value) {
  const btn = wrapper.querySelector('button, [aria-haspopup="listbox"]');
  if (!btn) return false;
  btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  btn.click();
  await wdSleep(300);
  // Workday sometimes shows a search box inside the popup
  const search = document.querySelector('input[data-automation-id="searchBox"], [data-automation-id="promptSearch"] input');
  if (search) { wdSet(search, value); await wdSleep(300); }
  const want = String(value).toLowerCase();
  const opts = [...document.querySelectorAll('[data-automation-id="promptOption"], [role="option"], [data-automation-id="menuItem"]')];
  const opt = opts.find((o) => o.textContent.trim().toLowerCase() === want)
    || opts.find((o) => o.textContent.trim().toLowerCase().includes(want));
  if (!opt) { document.body.click(); return false; }
  opt.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
  opt.click();
  await wdSleep(150);
  return true;
}

function wdHighlight(el) {
  const box = el.closest('[data-automation-id^="formField-"]') || el;
  box.style.outline = "2px dashed #f5a623"; box.style.outlineOffset = "2px";
}

async function fillWorkday(profile) {
  let filled = 0, flagged = 0;
  const values = Object.assign({}, profile, { city_only: cityOnly(profile.city), state: stateOf(profile) });

  for (const wrap of document.querySelectorAll('[data-automation-id^="formField-"]')) {
    const aid = wrap.getAttribute("data-automation-id") || "";
    const rule = WD_RULES.find((r) => r.re.test(aid));

    // Consequential Yes/No radios (previous worker, work auth, sponsorship) -> highlight.
    if (wrap.querySelector('input[type="radio"]') && /previous|authoriz|sponsor|visa|eligible/i.test(aid)) {
      wdHighlight(wrap); flagged++; continue;
    }
    if (!rule) continue;
    const val = values[rule.key];
    if (!val) continue;

    if (rule.kind === "text") {
      const inp = wrap.querySelector('input[type="text"], input:not([type]), input[type="tel"], input[type="email"]');
      if (!inp || inp.disabled) continue;
      if (inp.value && inp.value.trim()) continue;   // keep prefilled (account email)
      wdSet(inp, val); filled++;
    } else {
      try { if (await wdDropdown(wrap, val)) filled++; else { wdHighlight(wrap); flagged++; } }
      catch (e) { wdHighlight(wrap); flagged++; }
    }
  }
  return { filled, flagged };
}
