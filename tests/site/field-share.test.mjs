import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createProfile } from "../../docs/js/core/profile.mjs";

const { filtersFromUrl, filterParams, filterSearch } = createProfile({ URLSearchParams, Date });
const browser = { window: {}, URL, URLSearchParams };
vm.createContext(browser);
vm.runInContext(readFileSync(new URL("../../docs/js/share.js", import.meta.url), "utf8"), browser);
const fields = ["swe", "data", "finance", "accounting", "marketing", "mechanical", "electrical"];
const initial = { fields, states: ["all"], company: [], q: "", status: "open", sort: "new" };
const defaults = { sort: "new" };

test("normal share and reload retain more than six selected fields", () => {
  const link = browser.window.ISShare.searchLink(
    initial,
    { all: true, keys: [], noRemote: false },
    { allLoaded: true, first: ["MA"], indexKeys: ["MA", "remote"] },
    {},
    "https://internscout.org",
    filterParams,
  );
  assert.deepEqual(filtersFromUrl(new URL(link).search).fields, fields);
  const search = filterSearch("?utm_source=club", initial, defaults);
  assert.deepEqual(filtersFromUrl(search).fields, fields);
  assert.equal(new URLSearchParams(search).get("utm_source"), "club");
});

test("every supported field survives one shared URL in original order", () => {
  const majors = JSON.parse(readFileSync(new URL("../../docs/data/majors.json", import.meta.url)));
  assert(majors.fields.length > 6);
  const reversed = [...majors.fields].reverse();
  assert.deepEqual(
    filtersFromUrl(filterSearch("", { ...initial, fields: reversed }, defaults)).fields,
    reversed,
  );
});

test("invalid and duplicate fields cannot displace valid selections", () => {
  assert.deepEqual(
    filtersFromUrl("?field=swe,unknown,swe,data,constructor,__proto__,SWE,%3Cscript%3E,electrical")
      .fields,
    ["swe", "unknown", "data", "constructor", "__proto__", "electrical"],
  );
  assert.deepEqual(
    filtersFromUrl("?field=" + Array(400).fill("swe").concat(fields).join(",")).fields,
    fields,
  );
  assert.deepEqual(filtersFromUrl("?field=future_field,legacy_alias").fields, [
    "future_field",
    "legacy_alias",
  ]);
});

test("oversize field input is rejected without altering other filters", () => {
  const suffix =
    "&state=MA,remote&company=Example&q=research&stage=internship&year=junior&paid=1&new=1&sort=score&sector=health&where=remote&status=closed&progress=applied&eligible=1&citizen=hide";
  const expected = filtersFromUrl("?field=swe" + suffix);
  assert.deepEqual(filtersFromUrl("?field=" + "swe,".repeat(3000) + suffix), {
    ...expected,
    fields: [],
  });
  assert.deepEqual(filtersFromUrl("?field=" + "x".repeat(8192) + suffix), {
    ...expected,
    fields: [],
  });
  assert.deepEqual(filtersFromUrl("?field=swe&field=data" + suffix), expected);
});

test("bounded unique fields preserve order while duplicates consume no capacity", () => {
  const names = Array.from(
    { length: 129 },
    (_, n) => "field_" + String.fromCharCode(97 + Math.floor(n / 26), 97 + (n % 26)),
  );
  assert.deepEqual(
    filtersFromUrl("?field=" + names.flatMap((v) => [v, v]).join(",")).fields,
    names.slice(0, 128),
  );
  assert.deepEqual(filtersFromUrl("?field=ui,ux,co_op").fields, ["ui", "ux", "co_op"]);
});
