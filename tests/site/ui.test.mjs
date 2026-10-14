import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

// Exercise the components and their actual handlers without a browser or installing a DOM library.
function uiHarness() {
  const slots = []; let cursor = 0, pending = []; const events = [];
  const react = {
    Fragment: "fragment", memo: fn => fn,
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat().filter(x => x != null && x !== false) }),
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial; return [slots[i], v => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ||= { current: initial }; },
    useId() { return react.useRef("picker-" + cursor).current; },
    useMemo(fn) { cursor++; return fn(); },
    useCallback(fn) { cursor++; return fn; },
    useEffect(fn, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((x, j) => x !== old.deps[j])) { slots[i] = { deps }; pending.push(fn); } },
  };
  const ctx = { React: react, URLSearchParams, setTimeout, clearTimeout, console,
    CONFIG: {}, localStorage: { getItem() { return null; } }, sessionStorage: { getItem() { return null; } },
    addEventListener() {}, postMessage() {}, location: { search: "", origin: "https://internscout.org" },
    document: { documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {} } };
  ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("../../docs/js/core.js", import.meta.url), "utf8"), ctx);
  const app = readFileSync(new URL("../../docs/js/app.js", import.meta.url), "utf8");
  vm.runInContext(app.replace('ReactDOM.createRoot(document.getElementById("root")).render(h(App));', 'window.components = { MultiSelect, Setup, Row, Why };'), ctx);
  const attach = node => {
    if (!node || typeof node !== "object") return;
    if (node.props.ref) node.props.ref.current = {
      focus: () => events.push(["focus", node.props["aria-label"] || node.type]),
      scrollIntoView: options => events.push(["scroll", node.props["aria-label"] || node.type, options.block]),
      contains: () => false,
      children: node.children.map(child => ({ scrollIntoView: options => events.push(["active", child.props?.id, options.block]) })),
    };
    node.children.forEach(attach);
  };
  return { components: ctx.components, events,
    render(component, props) { cursor = 0; pending = []; const tree = component(props); attach(tree); pending.forEach(fn => fn()); return tree; } };
}
function nodes(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...tree.children.flatMap(child => nodes(child, predicate))];
}
function key(input, name) { input.props.onKeyDown({ key: name, preventDefault() {} }); }

test("picker keyboard navigation exposes and scrolls the active option, and Escape prevents hidden selection", () => {
  const harness = uiHarness(), chosen = [];
  const props = { placeholder: "Major", options: Array.from({ length: 45 }, (_, i) => ({ value: "v" + i, label: "Major " + i })), selected: [], onChange: v => chosen.push([...v]) };
  const render = () => harness.render(harness.components.MultiSelect, props);
  let tree = render(), input = nodes(tree, n => n.type === "input")[0];
  assert.equal(input.props.role, "combobox"); assert.equal(input.props["aria-expanded"], false);
  key(input, "ArrowDown"); tree = render();
  for (let i = 0; i < 34; i++) { key(nodes(tree, n => n.type === "input")[0], "ArrowDown"); tree = render(); }
  input = nodes(tree, n => n.type === "input")[0];
  const activeId = input.props["aria-activedescendant"];
  assert.equal(nodes(tree, n => n.props.id === activeId)[0].children[0].children[0], "Major 34");
  assert.equal(input.props["aria-controls"], nodes(tree, n => n.props.role === "listbox")[0].props.id);
  assert.ok(harness.events.some(([event, id, block]) => event === "active" && id === activeId && block === "nearest"));
  key(input, "Escape"); tree = render(); input = nodes(tree, n => n.type === "input")[0];
  assert.equal(input.props["aria-expanded"], false); key(input, "Enter"); assert.deepEqual(chosen, []);
});

test("profile steps move focus to the newly labelled group, including Back", () => {
  const harness = uiHarness();
  const props = { initial: null, majors: null, majorsReady: false, index: null, stats: null, statsReady: false, firstTime: true, onSave() {}, onClose() {}, onDelete() {}, signedIn: false };
  const render = () => harness.render(harness.components.Setup, props);
  let tree = render();
  assert.ok(harness.events.some(([event, label]) => event === "focus" && label.includes("step 1 of 3")));
  nodes(tree, n => n.type === "button" && n.children.includes("Next"))[0].props.onClick(); tree = render();
  assert.ok(harness.events.some(([event, label]) => event === "focus" && label.includes("step 2 of 3")));
  nodes(tree, n => n.type === "button" && n.children.includes("Back"))[0].props.onClick(); render();
  assert.equal(harness.events.filter(([event]) => event === "focus").at(-1)[1], "Profile step 1 of 3: About you");
});

test("Tab from a picker closes its list, the list is not a Tab stop, and arrows and Enter still pick", () => {
  const harness = uiHarness(), chosen = [];
  const props = { placeholder: "Field", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }], selected: [], onChange: v => chosen.push([...v]) };
  const render = () => harness.render(harness.components.MultiSelect, props);
  let tree = render(), input = nodes(tree, n => n.type === "input")[0];
  input.props.onFocus(); tree = render();
  const list = nodes(tree, n => n.props.role === "listbox")[0];
  // A scrolling box is focusable by default in Chrome and Firefox; was: Tab landed in it.
  assert.equal(list.props.tabIndex, -1);
  key(nodes(tree, n => n.type === "input")[0], "Tab"); tree = render();
  input = nodes(tree, n => n.type === "input")[0];
  assert.equal(input.props["aria-expanded"], false);
  assert.equal(nodes(tree, n => n.props.role === "listbox").length, 0);
  // Keyboard selection is unchanged.
  key(input, "ArrowDown"); tree = render(); key(nodes(tree, n => n.type === "input")[0], "ArrowDown"); tree = render();
  key(nodes(tree, n => n.type === "input")[0], "Enter");
  assert.deepEqual(chosen, [["b"]]);
});

test("a picker with no matches has no empty listbox and says so in a status line", () => {
  const harness = uiHarness();
  const props = { placeholder: "Field", options: [{ value: "a", label: "Alpha" }], selected: [], onChange() {} };
  const render = () => harness.render(harness.components.MultiSelect, props);
  let tree = render(); const input = nodes(tree, n => n.type === "input")[0];
  input.props.onChange({ target: { value: "zzzz" } }); tree = render();
  // was: role=listbox with no options inside, a critical axe violation (aria-required-children).
  assert.equal(nodes(tree, n => n.props.role === "listbox").length, 0);
  assert.equal(nodes(tree, n => n.props.role === "option").length, 0);
  const status = nodes(tree, n => n.props.role === "status")[0];
  assert.ok(status, "the empty state is a status message");
  assert.equal(status.children[0].children[0], "No more matching options");
  const now = nodes(tree, n => n.type === "input")[0];
  assert.equal(now.props["aria-expanded"], false);
  assert.equal(now.props["aria-activedescendant"], undefined);
  // Every option is back when the text is cleared.
  now.props.onChange({ target: { value: "" } }); tree = render();
  assert.equal(nodes(tree, n => n.props.role === "option").length, 1);
  assert.equal(nodes(tree, n => n.type === "input")[0].props["aria-expanded"], true);
});

// ---------- dashboard design rows (D8 to D19, 2026-10-14) ----------
const ROW = { id: 7, company_name: "Acme", title: "Data Intern", apply_url: "https://boards.greenhouse.io/acme/jobs/1", ats: "greenhouse", status: "open",
  field_tags: ["cs"], location_raw: "Boston, MA", regions: ["MA"], term: ["summer"], insights: {} };
const rowProps = extra => ({ r: ROW, sc: { score: 98, parts: {} }, ctx: { p: null, direct: new Set(), related: new Set() }, keys: new Set(["MA"]), state: "none", onState() {}, job: null,
  checked: false, onCheck() {}, canAuto: false, canTry: false, onAuto() {}, queueBusy: false, open: false, onWhy() {}, onRank() {}, elig: null, patterns: null, ...extra });
const text = n => typeof n === "string" || typeof n === "number" ? String(n) : n && typeof n === "object" ? n.children.map(text).join("") : "";

test("a set filter shows its count and says it (D8); Escape with the list closed is left to the dialog (D13)", () => {
  const harness = uiHarness();
  const props = { placeholder: "Field", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }], selected: ["a", "b"], count: 2, onChange() {} };
  let tree = harness.render(harness.components.MultiSelect, props);
  assert.match(tree.props.className, /\bset\b/);
  assert.equal(text(nodes(tree, n => n.props.className === "ms-count")[0]), "Field · 2");
  const input = nodes(tree, n => n.type === "input")[0];
  assert.equal(input.props["aria-label"], "Field, 2 picked");
  let prevented = false; input.props.onKeyDown({ key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(prevented, false, "a closed list lets Escape reach the setup card");
  tree = harness.render(harness.components.MultiSelect, { ...props, selected: [], count: 0 });
  assert.doesNotMatch(tree.props.className, /\bset\b/);
  assert.equal(nodes(tree, n => n.props.className === "ms-count").length, 0);
});

test("Escape closes the setup card unless a picker already used it (D13)", () => {
  const harness = uiHarness(); let closed = 0;
  const props = { initial: null, majors: null, majorsReady: false, index: null, stats: null, statsReady: false, firstTime: true, onSave() {}, onClose() { closed++; }, onDelete() {}, signedIn: false };
  const tree = harness.render(harness.components.Setup, props);
  tree.props.onKeyDown({ key: "Escape", defaultPrevented: true, preventDefault() {} }); assert.equal(closed, 0);
  tree.props.onKeyDown({ key: "Escape", defaultPrevented: false, preventDefault() {} }); assert.equal(closed, 1);
});

test("before a profile a row has no score, offers Rank for my major, and Report is gone from the row (D9 to D11)", () => {
  const harness = uiHarness(); let ranked = 0;
  const [tr] = harness.render(harness.components.Row, rowProps({ onRank: () => ranked++ })).children;
  const s = text(tr);
  assert.doesNotMatch(s, /\b98\b/); assert.doesNotMatch(s, /Report/);
  nodes(tr, n => n.type === "button" && text(n) === "Rank for my major")[0].props.onClick(); assert.equal(ranked, 1);
  const details = nodes(tr, n => n.props.className === "whybtn details")[0];
  assert.equal(details.props["aria-controls"], "why-7");
  // One facts line: field, place, term and pay together under the title.
  const facts = nodes(tr, n => n.props.className === "meta facts")[0];
  assert.match(text(facts), /summer.*Pay not listed/);
  assert.equal(nodes(facts, n => typeof n.type === "function" && n.type.name === "Loc").length, 1, "the place is on the same line");
  assert.match(text(nodes(tr, n => n.props.className === "open-link")[0]), /^Open posting/);
});

test("with a profile the Match button names its score and the panel it opens (D9, D12)", () => {
  const harness = uiHarness();
  const tree = harness.render(harness.components.Row, rowProps({ ctx: { p: { majors: ["Computer Science"] }, direct: new Set(["cs"]), related: new Set() } }));
  const btn = nodes(tree, n => n.props.className && /score whybtn/.test(n.props.className))[0];
  // The name comes from the visible text plus screen-reader words, so it always contains what is shown.
  assert.equal(btn.props["aria-label"], undefined);
  // U12: and the row it is for, so 150 of them don't all read the same.
  assert.match(text(btn), /^Match 98 of 100, Why: Acme, Data Intern$/);
  assert.equal(btn.props["aria-controls"], "why-7");
  assert.equal(nodes(tree, n => n.props.className === "rankbtn").length, 0);
});

test("the Why panel uses h3 headings, keeps Report, and closes on Escape (D11, D13)", () => {
  const harness = uiHarness(); let closed = 0;
  for (const p of [null, { majors: ["Computer Science"] }]) {
    const tree = harness.render(harness.components.Why, { r: ROW, sc: { score: 98, parts: {} }, ctx: { p, direct: new Set(), related: new Set() }, elig: null, patterns: null, onClose: () => closed++, onRank() {} });
    assert.equal(nodes(tree, n => n.type === "h4").length, 0);
    assert.ok(nodes(tree, n => n.type === "h3").length >= 3);
    assert.match(text(tree), /Report a wrong tag or dead link/);
    tree.props.onKeyDown({ key: "Escape", preventDefault() {} });
  }
  assert.equal(closed, 2);
});

test("phones get a laptop install button that goes to install.html#phone (D19), and footer links are spaced (D20)", () => {
  const index = readFileSync(new URL("../../docs/index.html", import.meta.url), "utf8");
  const install = readFileSync(new URL("../../docs/install.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../../docs/js/app.js", import.meta.url), "utf8");
  assert.match(index, /class="btn touch-only" href="install.html#phone">Send Auto-Apply to my laptop</);
  assert.match(install, /<aside class="phonebar" id="phone">/);
  assert.match(app, /"#phone" \}, "Send Auto-Apply to my laptop"\)/);
  assert.match(index, /footer \.links\{display:flex;gap:var\(--s2\) var\(--s5\)/);
});

// ---------- dashboard UX rows (U9, U11, U12, 2026-10-14) ----------
test("Open posting is remembered, and back on the page the row asks once: Mark applied or Not yet (U9)", async () => {
  const harness = uiHarness(); const opened = [], answers = [];
  const props = rowProps({ onOpen: r => opened.push(r.id), onAnswer: (id, applied) => answers.push([id, applied]) });
  let tree = harness.render(harness.components.Row, props);
  nodes(tree, n => n.props.className === "open-link")[0].props.onClick({});
  assert.deepEqual(opened, [7]);
  assert.equal(nodes(tree, n => n.props.className === "ask").length, 0, "nothing until the page says the student came back");
  tree = harness.render(harness.components.Row, { ...props, ask: true });
  const line = nodes(tree, n => n.props.className === "ask")[0];
  assert.equal(line.props.id, "ask-7");
  assert.equal(text(line).replace(/Mark applied.*/, ""), "Did you apply to Acme?");
  nodes(line, n => n.type === "button" && text(n) === "Mark applied")[0].props.onClick();
  nodes(line, n => n.type === "button" && text(n) === "Not yet")[0].props.onClick();
  assert.deepEqual(answers, [[7, true], [7, false]]);
  // Focus goes to the row's status, which now shows the answer.
  await new Promise(r => setTimeout(r, 5));
  assert.ok(harness.events.some(([e, label]) => e === "focus" && label === "Your status for Data Intern at Acme"));
  // Not asked once the status says more than Interested, or while Auto-Apply holds the row.
  for (const extra of [{ state: "applied" }, { state: "interviewing" }, { job: { status: "working" } }])
    assert.equal(nodes(harness.render(harness.components.Row, { ...props, ask: true, ...extra }), n => n.props.className === "ask").length, 0);
  assert.equal(nodes(harness.render(harness.components.Row, { ...props, ask: true, state: "interested" }), n => n.props.className === "ask").length, 1);
});

test("the dashboard asks only after the tab was hidden and shown again, and keeps the answer as the row's status (U9)", () => {
  const app = readFileSync(new URL("../../docs/js/app.js", import.meta.url), "utf8");
  assert.match(app, /if \(document\.visibilityState === "hidden"\) \{ o\.left = true; return; \}\s*if \(!o\.left\) return;/);
  assert.match(app, /if \(applied\) setAppState\(id, "applied"\); else notYet\.current\.add\(id\);/);
  assert.match(app, /ask: askId === r\.id, onOpen, onAnswer/);
});

test("with the extension, rows outside the sites it can already fill say it asks for site access (U11)", () => {
  const harness = uiHarness();
  const other = { ...ROW, ats: "other", apply_url: "https://careers.acme.com/1" };
  let tree = harness.render(harness.components.Row, rowProps({ r: other, canAuto: true }));
  const note = nodes(tree, n => n.props.className === "aa-note")[0];
  assert.equal(text(note), "asks for site access");
  const btn = nodes(tree, n => n.props.className === "rowbtn")[0];
  assert.equal(btn.props["aria-describedby"], note.props.id);
  // Not on a supported site, and not without the extension.
  tree = harness.render(harness.components.Row, rowProps({ canAuto: true }));
  assert.equal(nodes(tree, n => n.props.className === "aa-note").length, 0);
  assert.equal(nodes(tree, n => n.props.className === "rowbtn")[0].props["aria-describedby"], undefined);
  tree = harness.render(harness.components.Row, rowProps({ r: other, canAuto: false }));
  assert.equal(nodes(tree, n => n.props.className === "aa-note").length, 0);
});

test("a row's repeated controls carry the company and title in their names (U12)", () => {
  const harness = uiHarness();
  let tree = harness.render(harness.components.Row, rowProps({ canAuto: true }));
  assert.equal(text(nodes(tree, n => n.props.className === "open-link")[0]), "Open posting, Acme, Data Intern (opens in a new tab)");
  assert.equal(text(nodes(tree, n => n.props.className === "rowbtn")[0]), "Auto-Apply: Acme, Data Intern");
  assert.equal(nodes(tree, n => n.type === "select")[0].props["aria-label"], "Your status for Data Intern at Acme");
  assert.equal(nodes(tree, n => n.type === "input")[0].props["aria-label"], "Select Acme, Data Intern");
  tree = harness.render(harness.components.Row, rowProps({ canTry: true }));
  assert.equal(text(nodes(tree, n => n.props.className === "rowbtn try")[0]), "Auto-Apply: Acme, Data Intern");
});

test("install.html and privacy.html headings don't skip a level (U12), and install's steps follow what happens (U6)", () => {
  const strip = s => s.replace(/<!--[\s\S]*?-->/g, "");
  for (const page of ["install.html", "privacy.html"]) {
    const html = strip(readFileSync(new URL("../../docs/" + page, import.meta.url), "utf8"));
    const levels = [...html.matchAll(/<h([1-6])\b/g)].map(m => Number(m[1]));
    assert.equal(levels[0], 1, page);
    levels.forEach((l, i) => { if (i) assert.ok(l <= levels[i - 1] + 1, `${page}: h${levels[i - 1]} then h${l}`); });
    // The phone banner's h2 is hidden on a laptop, so the page must not lean on it.
    const noPhone = html.replace(/<aside class="phonebar"[\s\S]*?<\/aside>/, "");
    const after = [...noPhone.matchAll(/<h([1-6])\b/g)].map(m => Number(m[1]));
    assert.ok(after[1] <= 2, page + ": the heading after the h1 is an h2 without the phone banner too");
  }
  const install = strip(readFileSync(new URL("../../docs/install.html", import.meta.url), "utf8"));
  const steps = [...install.match(/<ol class="steps">[\s\S]*?<\/ol>/)[0].matchAll(/<h2>([^<]+)<\/h2>/g)].map(m => m[1]);
  assert.deepEqual(steps, ["Add it from the Chrome Web Store", "Set up Auto-Apply", "Pin it to your toolbar (optional)"]);
  assert.match(install, /<strong>Read and change your data on a number of websites<\/strong> and <strong>Read your browsing history<\/strong>/);
  const howto = JSON.parse(install.match(/<script type="application\/ld\+json">\s*(\{"@context":"https:\/\/schema.org","@type":"HowTo"[\s\S]*?)<\/script>/)[1]);
  assert.deepEqual(howto.step.map(s => s.name), steps);
  assert.doesNotMatch(install, /Click the InternScout icon and choose/);
});
