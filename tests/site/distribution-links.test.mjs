import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const count = readFileSync(new URL("../../docs/js/count.js", import.meta.url), "utf8");
const install = readFileSync(new URL("../../docs/install.html", import.meta.url), "utf8");

function browser({ host = "internscout.org", webdriver = false, off = false } = {}) {
  const sent = [],
    listeners = {};
  const context = {
    location: {
      hostname: host,
      pathname: "/install.html",
      search: "?utm_source=example&utm_campaign=example",
    },
    navigator: {
      webdriver,
      sendBeacon: (_, blob) => {
        sent.push(JSON.parse(blob.text));
        return true;
      },
    },
    document: {
      referrer: "",
      addEventListener: (name, fn) => {
        listeners[name] = fn;
      },
    },
    localStorage: { getItem: () => (off ? "1" : null) },
    Blob: class {
      constructor(parts) {
        this.text = parts.join("");
      }
    },
    URL,
    URLSearchParams,
  };
  context.window = context;
  vm.runInNewContext(count, context);
  return {
    sent,
    click(marker) {
      const link = {
        href: "https://example.com/?private=value",
        getAttribute: (name) => (name === "data-distribution" ? marker : null),
      };
      listeners.click?.({
        target: { closest: (selector) => (selector === "a[href]" ? link : null) },
      });
    },
  };
}

test("install footer links to the current list and separate snippet builder", () => {
  const footer = install.match(/<footer>([\s\S]*?)<\/footer>/)[1];
  assert.match(
    footer,
    /<nav class="distribution-links" aria-label="More ways to use InternScout">/,
  );
  assert.match(
    footer,
    /href="https:\/\/github\.com\/bpmcginley\/internships-every-major" data-distribution="list">Internships for every major on GitHub<\/a>/,
  );
  assert.match(
    footer,
    /href="widget\/builder\.html" data-distribution="widget">Put live internships on your club or department site<\/a>/,
  );
  for (const href of ["index.html", "privacy.html", "terms.html"])
    assert.ok(footer.includes(`href="${href}"`));
});

test("marked links count once each without sending destination or campaign details", () => {
  const page = browser();
  for (const marker of ["list", "list", "widget", "widget"]) page.click(marker);
  assert.deepEqual(
    page.sent.filter((item) => item.e),
    [
      { e: "list_link_click", p: "/install.html" },
      { e: "widget_link_click", p: "/install.html" },
    ],
  );
});

test("unmarked and unknown markers do not become arbitrary event names", () => {
  const page = browser();
  for (const marker of [null, "", "LIST", "unknown", "signin", "__proto__"]) page.click(marker);
  assert.deepEqual(
    page.sent.filter((item) => item.e),
    [],
  );
});

test("distribution counts respect opt-out, local copies and automated browsers", () => {
  for (const options of [{ off: true }, { host: "localhost" }, { webdriver: true }]) {
    const page = browser(options);
    page.click("list");
    page.click("widget");
    assert.deepEqual(page.sent, []);
  }
});
