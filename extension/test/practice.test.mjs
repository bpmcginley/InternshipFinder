import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const html = readFileSync(new URL("../practice/practice.html", import.meta.url), "utf8");
const source = readFileSync(new URL("../practice/practice.js", import.meta.url), "utf8");

test("practice loads existing scripts in the injection order and blocks form and network actions", () => {
  const agent = readFileSync(new URL("../background/agent.js", import.meta.url), "utf8");
  const injection = agent.match(/const PAGE_FILES = \[([^\]]+)\]/)[1];
  assert.deepEqual(
    [...html.matchAll(/src="\.\.\/(agent\/[^" ]+)"/g)].map((match) => match[1]),
    [...injection.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
  );
  assert.match(html, /connect-src 'none'; form-action 'none'/);
  assert.match(html, /<form[^>]+autocomplete="off"/);
  const buttons = [...html.matchAll(/<button[^>]+>/g)].map(([button]) => button);
  assert.equal(buttons.length, 2);
  for (const button of buttons) assert.match(button, /type="button"/);
});

function runPage(fillFields) {
  const control = () => ({
    classList: { toggle() {} },
    addEventListener(name, callback) {
      this[name] = callback;
    },
  });
  const fields = ["first_name", "last_name", "email", "phone"].map((name) => ({
    name,
    value: "",
    readOnly: true,
  }));
  const form = { ...control(), querySelectorAll: () => fields };
  const fill = { ...control(), focus() {} };
  const complete = { ...control(), disabled: true };
  const result = { textContent: "" };
  const nodes = { form, "#fill": fill, "#complete": complete, "#result": result };
  runInNewContext(source, {
    document: { querySelector: (selector) => nodes[selector] },
    window: { ISDom: { fastFill: (...args) => fillFields(fields, ...args) } },
  });
  return { fields, form, fill, complete, result };
}

test("practice passes only fixed facts after a click and completes locally", async () => {
  let calls = 0;
  const page = runPage(async (fields, facts, file, options) => {
    calls++;
    assert.deepEqual(
      { ...facts },
      {
        first_name: "Sample",
        last_name: "Student",
        email: "sample.student@example.invalid",
        phone: "2025550100",
      },
    );
    assert.equal(file, null);
    assert.equal(options.gen, 1);
    for (const field of fields) {
      assert.equal(field.readOnly, false);
      field.value = facts[field.name];
    }
  });
  assert.equal(calls, 0);
  page.complete.click();
  assert.equal(page.result.textContent, "");
  await page.fill.click();
  assert.equal(calls, 1);
  assert.equal(page.complete.disabled, false);
  assert.ok(page.fields.every((field) => field.readOnly));
  page.complete.click();
  assert.equal(page.result.textContent, "Practice complete.");
  let prevented = false;
  page.form.submit({
    preventDefault: () => {
      prevented = true;
    },
  });
  assert.equal(prevented, true);
});

test("practice clears partial values and can be retried after a fill error", async () => {
  let fail = true;
  const page = runPage(async (fields, facts) => {
    fields[0].value = facts[fields[0].name];
    if (fail) throw Error("synthetic fill failure");
    for (const field of fields) field.value = facts[field.name];
  });
  await page.fill.click();
  assert.equal(page.complete.disabled, true);
  assert.match(page.result.textContent, /Try again/);
  assert.ok(page.fields.every((field) => field.readOnly && !field.value));
  fail = false;
  await page.fill.click();
  assert.equal(page.complete.disabled, false);
});

test("practice ignores repeat clicks while a fill is pending", async () => {
  let finish;
  let calls = 0;
  const page = runPage(async (fields, facts) => {
    calls++;
    await new Promise((resolve) => {
      finish = resolve;
    });
    for (const field of fields) field.value = facts[field.name];
  });
  const pending = page.fill.click();
  await page.fill.click();
  page.complete.click();
  assert.equal(calls, 1);
  assert.equal(page.result.textContent, "");
  assert.equal(page.complete.disabled, true);
  finish();
  await pending;
  assert.equal(page.complete.disabled, false);
});
