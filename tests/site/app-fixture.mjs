import { readFileSync } from "node:fs";
import { createApp } from "../../docs/js/app/index.mjs";

export function createTestApp(browser) {
  browser.Date ??= Date;
  browser.Intl ??= Intl;
  browser.URL ??= URL;
  browser.URLSearchParams ??= URLSearchParams;
  return createApp(browser);
}

export function readAppSource() {
  return ["index", "allowance", "tracker", "presentation", "extension", "controls", "rows",
    "navigation", "setup", "dashboard", "entry"]
    .map(name => readFileSync(new URL(`../../docs/js/app/${name}.mjs`, import.meta.url), "utf8"))
    .join("\n");
}
