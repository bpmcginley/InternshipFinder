import test from "node:test";
import assert from "node:assert/strict";
import { createProfile } from "../../docs/js/core/profile.mjs";
const { fieldLabel } = createProfile({ Date });

test("Core field labels preserve each public mapping and the existing unknown-key fallback", () => {
  for (const [key, label] of Object.entries({
    swe: "Software",
    ml: "ML / AI",
    pm: "Product / program mgmt",
    hr: "HR",
    ui: "UI",
    ux: "UX",
    co_op: "Co-op",
    abc: "ABC",
    finance: "Finance",
    future_field: "Future field",
  }))
    assert.equal(fieldLabel(key), label);
});

test("Core inherited field keys preserve the raw key, never Object prototype values", () => {
  for (const [key, label] of [
    ["constructor", "constructor"],
    ["__proto__", "__proto__"],
    ["toString", "toString"],
    ["valueOf", "valueOf"],
  ]) {
    assert.equal(typeof fieldLabel(key), "string");
    assert.equal(fieldLabel(key), label);
  }
});
