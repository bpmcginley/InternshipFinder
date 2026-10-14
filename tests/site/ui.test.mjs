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
  vm.runInContext(app.replace('ReactDOM.createRoot(document.getElementById("root")).render(h(App));', 'window.components = { MultiSelect, Setup };'), ctx);
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
