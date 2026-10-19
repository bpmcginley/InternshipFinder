import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = {
  React: {
    Fragment: "fragment", memo: fn => fn,
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(x => x != null && x !== false) }),
  },
  CONFIG: {}, URLSearchParams, console,
  localStorage: { getItem() { return null; } }, sessionStorage: { getItem() { return null; } },
  addEventListener() {}, postMessage() {},
  location: { search: "", origin: "https://internscout.org" },
  document: { documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {} },
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(readFileSync(new URL("../../docs/js/core.js", import.meta.url), "utf8"), ctx);
const source = readFileSync(new URL("../../docs/js/app.js", import.meta.url), "utf8");
vm.runInContext(source.replace('ReactDOM.createRoot(document.getElementById("root")).render(h(App));', "window.ListTable = ListTable;"), ctx);
const h = ctx.React.createElement;
function nodes(tree, predicate) {
  if (!tree || typeof tree !== "object") return [];
  return [...(predicate(tree) ? [tree] : []), ...tree.children.flatMap(child => nodes(child, predicate))];
}
const listings = n => Array.from({ length: n }, (_, i) => ({ id: "listing-" + i }));
function render(shown, extra = {}) {
  return ctx.ListTable({ shown, rows: shown, renderRow: row => h("tr", { "data-listing": row.id }), onMore() {}, ...extra });
}

test("weekly invitation appears once after ten listings without changing order or pagination", () => {
  for (const phone of [false, true]) for (const columns of [4, 5]) {
    const shown = listings(150), rows = listings(170); let more = 0;
    const tree = render(shown, { rows, phone, columns, inlineSignup: h("form", { id: "inline" }), onMore() { more++; } });
    const body = nodes(tree, n => n.type === "tbody")[0];
    const prompt = nodes(body, n => n.props.className === "digest-in-list");
    assert.equal(prompt.length, 1);
    assert.equal(body.children.indexOf(prompt[0]), 10);
    assert.equal(prompt[0].children[0].props.colSpan, columns);
    assert.deepEqual(nodes(tree, n => n.props["data-listing"]).map(n => n.props["data-listing"]), shown.map(r => r.id));
    assert.equal(nodes(tree, n => n.props.id === "list-end")[0].children[0], "End of the 150 listings shown");
    const button = nodes(tree, n => n.type === "button")[0];
    assert.equal(button.children[0], "Show 20 more"); button.props.onClick(); assert.equal(more, 1);
  }
});

test("lists of ten or fewer leave the invitation to the footer form right after them", () => {
  // was: placed after the last listing too, which put two forms in a row (review of #123).
  for (const count of [0, 1, 3, 9, 10]) {
    const tree = render(listings(count), { inlineSignup: h("form", { id: "inline" }) });
    const body = nodes(tree, n => n.type === "tbody")[0];
    assert.equal(nodes(body, n => n.props.className === "digest-in-list").length, 0, String(count));
  }
  assert.equal(nodes(render(listings(15)), n => n.props.className === "digest-in-list").length, 0);
});

test("the mobile paid listing stays after three rows and cannot count toward the weekly invitation", () => {
  for (const count of [1, 3, 10, 20]) {
    const tree = render(listings(count), { phone: true, box: h("aside", { id: "paid" }), inlineSignup: h("form", { id: "inline" }) });
    const body = nodes(tree, n => n.type === "tbody")[0];
    const paid = nodes(body, n => n.props.className === "paid-row")[0];
    const prompt = nodes(body, n => n.props.className === "digest-in-list")[0];
    assert.equal(body.children.indexOf(paid), Math.min(3, count));
    if (count > 10) assert.equal(body.children.indexOf(prompt), 11);
    else assert.equal(prompt, undefined);
    assert.equal(nodes(body, n => n.props["data-listing"]).length, count);
  }
});
