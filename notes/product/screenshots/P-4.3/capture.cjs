// Captures local synthetic Pages output. No request is allowed to leave the browser fixture.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const tools = path.join(process.env.TEMP, "internscout-product-capture-tools", "node_modules");
const { chromium } = require(path.join(tools, "playwright-core"));
const [before, after] = process.argv.slice(2);
assert(before && after, "Supply the before and after synthetic Pages output directories");
const origin = "https://internscout.test";
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".css": "text/css",
};

async function check(browser, site, phase, width, colorScheme) {
  const context = await browser.newContext({
    viewport: { width, height: 1000 },
    hasTouch: width === 375,
    colorScheme,
    reducedMotion: "reduce",
  });
  let blocked = 0;
  const errors = [];
  try {
    await context.addInitScript(() => {
      localStorage.setItem("internscout.setup.skipped.v1", "true");
      localStorage.setItem("internscout.landing.seen.v1", "true");
      window.copied = [];
      window.shareMode = "clipboard";
      Object.defineProperty(navigator, "share", {
        configurable: true,
        get: () =>
          window.shareMode === "native"
            ? async ({ url }) => {
                window.nativeShare = url;
              }
            : window.shareMode === "cancel"
              ? async () => {
                  throw new DOMException("Cancelled", "AbortError");
                }
              : undefined,
      });
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (url) => {
            if (window.shareMode === "denied") throw new DOMException("Denied", "NotAllowedError");
            window.copied.push(url);
          },
        },
      });
    });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === "cdn.jsdelivr.net" && /react(?:-dom)?@/.test(url.pathname)) {
        const name = url.pathname.includes("react-dom@") ? "react-dom" : "react";
        return route.fulfill({
          path: path.join(tools, name, "umd", name + ".production.min.js"),
          contentType: "text/javascript",
        });
      }
      if (url.origin !== origin) {
        blocked++;
        return route.abort();
      }
      if (url.pathname === "/data/placements.json")
        return route.fulfill({ json: { placements: [] } });
      let name = decodeURIComponent(url.pathname).slice(1);
      if (!name || name.endsWith("/")) name += "index.html";
      const file = path.resolve(site, name);
      assert(file.startsWith(path.resolve(site) + path.sep));
      if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ path: file, contentType: types[path.extname(file)] });
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin + "/?field=swe&state=all");
    const filterbar = page.locator(".filterbar-foot");
    await filterbar.waitFor();
    await page.evaluate(() => document.fonts.ready);
    await filterbar.getByText(/^29 listings match in every state$/).waitFor();
    const share = page.getByRole("button", { name: "Share search" });
    assert.equal(await share.count(), phase === "after" ? 1 : 0);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
    );
    await filterbar.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const png = await page.screenshot({
      path: path.join(__dirname, `${phase}-${width}-${colorScheme}.png`),
    });
    assert.equal(png.readUInt32BE(16), width);
    if (phase === "after") {
      const target = origin + "/internships/software-engineering/";
      await share.focus();
      await page.keyboard.press("Enter");
      await filterbar.getByText("Link copied.").waitFor();
      assert.deepEqual(await page.evaluate(() => window.copied), [target]);
      await page.evaluate(() => {
        window.shareMode = "native";
      });
      await share.click();
      await page.waitForFunction((expected) => window.nativeShare === expected, target);
      await page.evaluate(() => {
        window.shareMode = "cancel";
      });
      await share.click();
      assert.deepEqual(await page.evaluate(() => window.copied), [target]);
      await page.evaluate(() => {
        window.shareMode = "denied";
      });
      await share.click();
      const manual = filterbar.getByRole("textbox", { name: "Copy this link" });
      await manual.waitFor();
      assert.equal(await manual.inputValue(), target);
      assert.equal(
        await manual.evaluate(
          (element) =>
            element === document.activeElement &&
            element.selectionStart === 0 &&
            element.selectionEnd === element.value.length,
        ),
        true,
      );
      await page.getByRole("button", { name: /^My list/ }).click();
      assert.equal(await share.count(), 0);
    }
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ phase, width, colorScheme, blocked, pageErrors: errors.length }));
  } finally {
    await context.close();
  }
}

(async () => {
  const browser = await chromium.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  try {
    for (const width of [1280, 375])
      for (const theme of ["light", "dark"]) {
        await check(browser, before, "before", width, theme);
        await check(browser, after, "after", width, theme);
      }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
