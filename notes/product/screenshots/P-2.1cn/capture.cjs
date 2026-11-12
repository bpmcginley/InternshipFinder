const assert = require("node:assert/strict");
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
const tools = path.join(process.env.TEMP, "internscout-product-capture-tools/node_modules");
const { chromium } = require(path.join(tools, "playwright-core"));
const [before, after] = process.argv.slice(2);
assert(before && after);
const origin = "https://internscout.org",
  api = "https://internscout-api.bpmcginley.workers.dev";
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".css": "text/css",
};
let checks = 0;
async function scenario(browser, site, phase, width, theme, enabled, signedIn = false) {
  const context = await browser.newContext({
    viewport: { width, height: 1000 },
    colorScheme: theme,
    reducedMotion: "reduce",
  });
  const token = "iss_" + crypto.randomBytes(32).toString("base64url");
  await context.addInitScript(
    ({ signedIn, token }) => {
      localStorage.setItem("internscout.setup.skipped.v1", "true");
      localStorage.setItem("internscout.landing.seen.v1", "true");
      if (signedIn)
        localStorage.setItem(
          "internscout.session",
          JSON.stringify({
            token,
            account: "synthetic",
            email: "synthetic@example.test",
            expires: "2099-01-01T00:00:00Z",
          }),
        );
    },
    { signedIn, token },
  );
  const calls = [],
    errors = [];
  let held = null,
    nextStatus = 202,
    external = 0;
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "cdn.jsdelivr.net" && /react(?:-dom)?@/.test(url.pathname)) {
      const name = url.pathname.includes("react-dom@") ? "react-dom" : "react";
      return route.fulfill({
        path: path.join(tools, name, "umd", name + ".production.min.js"),
        contentType: "text/javascript",
      });
    }
    if (url.origin === api) {
      const headers = {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      };
      if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
      if (url.pathname === "/follows/signup") {
        const request = route.request(),
          body = request.postDataJSON();
        calls.push({ body, headers: request.headers(), url: request.url() });
        if (nextStatus === "held") {
          held = () => route.fulfill({ status: 202, headers });
          return;
        }
        return route.fulfill({ status: nextStatus, headers, body: nextStatus === 200 ? "{}" : "" });
      }
      return route.fulfill({ status: 404, headers, body: "" });
    }
    if (url.hostname === "static.cloudflareinsights.com")
      return route.fulfill({ contentType: "text/javascript", body: "" });
    if (url.origin !== origin) {
      external++;
      return route.abort();
    }
    if (url.pathname === "/data/placements.json")
      return route.fulfill({ json: { placements: [] } });
    let name = decodeURIComponent(url.pathname).slice(1);
    if (!name || name.endsWith("/")) name += "index.html";
    const file = path.resolve(site, name);
    assert(file.startsWith(path.resolve(site) + path.sep));
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    let body = fs.readFileSync(file);
    if (name === "index.html" && enabled)
      body = Buffer.from(
        body.toString().replace("<html ", '<html data-follow-signup-enabled="1" '),
      );
    return route.fulfill({ body, contentType: types[path.extname(file)] });
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/?field=swe&state=MA");
  const foot = page.locator(".filterbar-foot");
  await foot.waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".countline")?.textContent.includes("Loading"),
  );
  await page.evaluate(() => document.fonts.ready);
  await page
    .getByRole("combobox", { name: /^Field/ })
    .evaluate((el) => el.closest(".ms").scrollIntoView({ block: "start" }));
  const toggle = page.getByRole("button", { name: "Email me new roles like these", exact: true });
  assert.equal(calls.length, 0);
  let png;
  if (!enabled) {
    assert.equal(await toggle.count(), 0);
    await foot.evaluate((el) => el.scrollIntoView({ block: "start" }));
    png = await page.screenshot({
      path: phase === "before" ? path.join(__dirname, `before-${width}-${theme}.png`) : undefined,
    });
  } else {
    await toggle.focus();
    await page.keyboard.press("Enter");
    const email = page.locator("input[type=email][aria-invalid]");
    await email.waitFor();
    assert(await email.evaluate((el) => el === document.activeElement));
    assert.equal(
      await page.getByRole("checkbox", { name: /Link these follows/ }).count(),
      signedIn ? 1 : 0,
    );
    if (signedIn)
      assert.equal(
        await page.getByRole("checkbox", { name: /Link these follows/ }).isChecked(),
        false,
      );
    await page
      .getByText(
        "Following: Software; Massachusetts (MA). Other search filters are not included.",
        { exact: true },
      )
      .waitFor();
    await foot.evaluate((el) => el.scrollIntoView({ block: "start" }));
    for (const control of [
      toggle,
      email,
      page
        .getByRole("form", { name: "Email me new roles like these", exact: true })
        .getByRole("button", { name: "Email me new internships", exact: true }),
    ]) {
      assert((await control.boundingBox()).height >= 44);
    }
    png = await page.screenshot({
      path: path.join(
        __dirname,
        `after-${signedIn ? "linked-option" : "anonymous"}-${width}-${theme}.png`,
      ),
    });
    await email.fill("synthetic@example.test");
    if (signedIn) {
      await page.keyboard.press("Tab");
      assert(
        await page
          .getByRole("checkbox", { name: /Link these follows/ })
          .evaluate((el) => el === document.activeElement),
      );
      await page.keyboard.press("Space");
    }
    const submit = page
      .getByRole("form", { name: "Email me new roles like these", exact: true })
      .getByRole("button", { name: "Email me new internships", exact: true });
    await submit.focus();
    await page.keyboard.press("Enter");
    await page
      .getByText("If this address can receive email, a confirmation link is on its way.", {
        exact: true,
      })
      .waitFor();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body, {
      email: "synthetic@example.test",
      link: signedIn,
      scope: { kind: "search", fields: ["swe"], states: ["MA"] },
    });
    assert.equal(calls[0].headers.authorization, signedIn ? "Bearer " + token : undefined);
    assert.equal(calls[0].headers.referer, undefined);
    assert(
      await page
        .getByRole("status")
        .filter({ hasText: "If this address" })
        .evaluate((el) => el === document.activeElement),
    );
    await page.keyboard.press("Escape");
    assert(await toggle.evaluate((el) => el === document.activeElement));
    await page.keyboard.press("Enter");
    assert.equal(await email.inputValue(), "");
    // A malformed 200 cannot become accepted, and changing filters aborts/discards late success.
    nextStatus = 200;
    await email.fill("synthetic@example.test");
    await submit.click();
    await page
      .getByText("Email follows are unavailable. Please try again later.", { exact: true })
      .waitFor();
    nextStatus = "held";
    await submit.click();
    await page.waitForFunction(() => document.querySelector("input[type=email]")?.disabled);
    while (!held) await new Promise((r) => setTimeout(r, 10));
    const field = page.getByRole("combobox", { name: /^Field/ });
    await field.fill("finance");
    await page.getByRole("option").first().waitFor();
    await field.press("Enter");
    await field.press("Escape");
    await held().catch(() => {});
    await page.waitForTimeout(30);
    assert.equal(await page.locator("input[type=email][aria-invalid]").count(), 0);
    assert.equal(
      await page
        .getByText("If this address can receive email, a confirmation link is on its way.", {
          exact: true,
        })
        .count(),
      0,
    );
    await toggle.click();
    assert.equal(await email.inputValue(), "");
    if (signedIn)
      assert.equal(
        await page.getByRole("checkbox", { name: /Link these follows/ }).isChecked(),
        false,
      );
    if (signedIn) {
      held = null;
      await email.fill("synthetic@example.test");
      await page.getByRole("checkbox", { name: /Link these follows/ }).check();
      await submit.click();
      while (!held) await new Promise((resolve) => setTimeout(resolve, 10));
      await page.getByRole("button", { name: "Account", exact: true }).click();
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await held().catch(() => {});
      await page.waitForTimeout(30);
      assert.equal(await email.count(), 0);
      assert.equal(calls.length, 4);
      assert.equal(calls[3].body.link, true);
      await toggle.click();
      assert.equal(await page.getByRole("checkbox", { name: /Link these follows/ }).count(), 0);
      assert.equal(await email.inputValue(), "");
    }
    for (const query of [
      "field=swe&state=all,MA",
      "field=swe&state=remote",
      "field=swe&state=Canada",
      "q=engineering",
      "state=all",
    ]) {
      await page.goto(origin + "/?" + query);
      await page.locator(".filterbar-foot").waitFor();
      assert.equal(await toggle.count(), 0, query);
    }
    for (const [query, summary] of [
      [
        "field=swe&state=all",
        "Following: Software; Anywhere. Other search filters are not included.",
      ],
      [
        "state=MA",
        "Following: All fields; Massachusetts (MA). Other search filters are not included.",
      ],
    ]) {
      await page.goto(origin + "/?" + query);
      await toggle.waitFor();
      await toggle.click();
      await page.getByText(summary, { exact: true }).waitFor();
    }
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.equal(external, 0);
  assert.deepEqual(errors, []);
  checks++;
  console.log(
    JSON.stringify({ phase, width, theme, signedIn, syntheticCalls: calls.length, external }),
  );
  await context.close();
  return png;
}
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  });
  try {
    for (const width of [1280, 375])
      for (const theme of ["light", "dark"]) {
        const a = await scenario(browser, before, "before", width, theme, false),
          b = await scenario(browser, after, "default", width, theme, false);
        assert(a.equals(b), "Default dashboard pixels changed");
        await scenario(browser, after, "after", width, theme, true);
        await scenario(browser, after, "after", width, theme, true, true);
      }
    console.log(
      `${checks} actual dashboard browser scenarios; 12 PNGs; four byte-identical default screenshots`,
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
