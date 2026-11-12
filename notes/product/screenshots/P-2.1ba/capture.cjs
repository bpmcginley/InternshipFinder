// Offline browser qualification with invented, in-memory credentials and a mocked API.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID, randomBytes } = require("node:crypto");
const { chromium } = require(
  path.join(process.env.TEMP, "internscout-product-capture-tools/node_modules/playwright-core"),
);
const [before, after] = process.argv.slice(2);
const origin = "https://internscout.test";
const api = "https://internscout-api.bpmcginley.workers.dev";
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".json": "application/json",
};
async function check(browser, site, phase, width, colorScheme, purpose) {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
    colorScheme,
    reducedMotion: "reduce",
  });
  const token =
    (purpose === "delete-request" ? "fd_" : "") +
    randomUUID() +
    "." +
    randomBytes(32).toString("hex");
  const errors = [];
  let expectedToken = token,
    expectedPurpose = purpose;
  let posts = 0,
    blocked = 0,
    result = 204;
  await context.route("**/*", (route) => {
    const request = route.request(),
      url = new URL(request.url());
    assert.equal(url.hash, "");
    if (url.origin === api && phase === "after") {
      assert.equal(request.method(), "POST");
      assert.equal(url.pathname, "/follows/" + expectedPurpose);
      assert.equal(url.search, "");
      assert.equal(request.postData(), expectedToken);
      assert.equal(request.headers().referer, undefined);
      assert.equal(request.headers().cookie, undefined);
      posts++;
      return route.fulfill({
        status: result,
        headers: { "Access-Control-Allow-Origin": origin },
        body: "",
      });
    }
    if (url.origin !== origin) {
      blocked++;
      return route.abort();
    }
    if (phase === "after") assert.equal(url.search, "");
    const name = url.pathname.endsWith("/") ? url.pathname + "index.html" : url.pathname;
    const file = path.resolve(site, "." + name);
    assert(file.startsWith(path.resolve(site) + path.sep));
    if (!fs.existsSync(file))
      return route.fulfill({
        status: 404,
        path: path.join(site, "404.html"),
        contentType: "text/html",
      });
    return route.fulfill({ path: file, contentType: types[path.extname(file)] });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.name));
  const link = origin + `/follows/action.html#purpose=${purpose}&token=${token}`;
  try {
    await page.goto(link);
    if (phase === "after") {
      assert.equal(page.url(), origin + "/follows/action.html");
      assert.equal(posts, 0);
      const button = page.getByRole("button", {
        name: purpose === "confirm" ? "Confirm" : "Delete this request",
        exact: true,
      });
      await button.waitFor();
      const box = await button.boundingBox();
      assert(box.height >= 44 && box.width >= 44);
      assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
      // Arrive through normal Tab order, including the visible skip link and brand.
      for (let i = 0; i < 5 && !(await button.evaluate((el) => el === document.activeElement)); i++)
        await page.keyboard.press("Tab");
      assert(await button.evaluate((el) => el === document.activeElement));
      if (purpose === "delete-request") {
        await page.keyboard.press("Enter");
        await page
          .getByRole("status")
          .getByText(/^If this link matched/)
          .waitFor();
        assert.equal(posts, 1);
        assert(await button.isDisabled());
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
    }
    await page.evaluate(() => document.fonts.ready);
    const png = await page.screenshot({
      path: path.join(__dirname, `${phase}-${purpose}-${width}-${colorScheme}.png`),
    });
    assert.equal(png.readUInt32BE(16), width);
    if (phase === "after" && purpose === "confirm") {
      await page.keyboard.press("Enter");
      await page
        .getByRole("status")
        .getByText("Your follows are active.", { exact: true })
        .waitFor();
      assert.equal(posts, 1);
      await page.reload();
      await page
        .getByRole("status")
        .getByText(/^This link is invalid/)
        .waitFor();
      assert.equal(posts, 1);
      // Retry is explicit, and 410/error outcomes are announced without server details.
      result = 503;
      await page.goto("about:blank");
      await page.goto(link);
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await page
        .getByRole("status")
        .getByText(/^Email follows are unavailable/)
        .waitFor();
      assert.equal(posts, 2);
      result = 410;
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await page
        .getByRole("status")
        .getByText(/^This link can no longer be used/)
        .waitFor();
      assert.equal(posts, 3);
      await page.evaluate((hash) => {
        location.hash = hash;
      }, `purpose=confirm&token=${token}`);
      await page.waitForFunction(() => !location.hash);
      assert(await page.getByRole("button", { name: "Confirm", exact: true }).isEnabled());
      expectedPurpose = "delete-request";
      expectedToken = "fd_" + randomUUID() + "." + randomBytes(32).toString("hex");
      result = 204;
      await page.evaluate((hash) => {
        location.hash = hash;
      }, `purpose=${expectedPurpose}&token=${expectedToken}`);
      await page.waitForFunction(() => !location.hash);
      const replacement = page.getByRole("button", { name: "Delete this request", exact: true });
      await replacement.waitFor();
      assert.equal(posts, 3);
      await page.locator(".skip").focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => location.hash === "#main");
      assert(await replacement.isEnabled());
      await replacement.click();
      await page
        .getByRole("status")
        .getByText(/^If this link matched/)
        .waitFor();
      assert.equal(posts, 4);
      await page.reload();
      await page
        .getByRole("status")
        .getByText(/^This link is invalid/)
        .waitFor();
      expectedPurpose = "confirm";
      expectedToken = randomUUID() + "." + randomBytes(32).toString("hex");
      await page.evaluate((hash) => {
        location.hash = hash;
      }, `purpose=${expectedPurpose}&token=${expectedToken}`);
      await page.waitForFunction(() => !location.hash);
      const reopened = page.getByRole("button", { name: "Confirm", exact: true });
      await reopened.waitFor();
      assert.equal(posts, 4);
      await reopened.click();
      await page
        .getByRole("status")
        .getByText("Your follows are active.", { exact: true })
        .waitFor();
      assert.equal(posts, 5);
    }
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify({
        phase,
        purpose,
        width,
        colorScheme,
        posts,
        blocked,
        pageErrors: errors.length,
      }),
    );
  } finally {
    await context.close();
  }
}
async function lifecycleOrder(browser, site) {
  for (const rejected of [false, true]) {
    const context = await browser.newContext();
    try {
      await context.route("**/*", (route) => {
        if (route.request().url() === origin + "/follows/action.html")
          return route.fulfill({
            path: path.join(site, "follows/action.html"),
            contentType: "text/html",
          });
        return route.abort();
      });
      await context.addInitScript(() => {
        window.syntheticCalls = [];
        window.fetch = (url, init) =>
          new Promise((resolve, reject) => {
            window.syntheticCalls.push({
              url,
              signal: init.signal,
              settle: () => resolve({ status: 204 }),
              fail: () => reject(new Error("synthetic failure")),
            });
          });
      });
      const page = await context.newPage();
      const first = randomUUID() + "." + randomBytes(32).toString("hex");
      const next = "fd_" + randomUUID() + "." + randomBytes(32).toString("hex");
      await page.goto(origin + `/follows/action.html#purpose=confirm&token=${first}`);
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      // Forced lifecycle ordering, not a claim about natural BFCache scheduling.
      await page.evaluate(
        ({ fragment, rejected }) => {
          location.hash = fragment;
          dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
          if (rejected) syntheticCalls[0].fail();
          else syntheticCalls[0].settle();
          queueMicrotask(() =>
            dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })),
          );
        },
        { fragment: `purpose=delete-request&token=${next}`, rejected },
      );
      await page
        .getByRole("status")
        .getByText(/^This link is invalid/)
        .waitFor();
      assert.equal(page.url(), origin + "/follows/action.html");
      assert(await page.locator("#action").isHidden());
      assert(await page.locator("#action").isDisabled());
      assert.equal(await page.evaluate(() => syntheticCalls.length), 1);
      assert(await page.evaluate(() => syntheticCalls[0].signal.aborted));
      await page.locator("#action").evaluate((button) => button.click());
      assert.equal(await page.evaluate(() => syntheticCalls.length), 1);
      await page.evaluate((fragment) => {
        location.hash = fragment;
      }, `purpose=delete-request&token=${next}`);
      const action = page.getByRole("button", { name: "Delete this request", exact: true });
      await action.waitFor();
      assert.equal(await page.evaluate(() => syntheticCalls.length), 1);
      await action.click();
      assert.equal(await page.evaluate(() => syntheticCalls.length), 2);
      console.log(
        JSON.stringify({
          syntheticLifecycleOrder: true,
          rejected,
          inertRestore: true,
          automaticPosts: 0,
        }),
      );
    } finally {
      await context.close();
    }
  }
}
(async () => {
  assert(before && after);
  const browser = await chromium.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  try {
    await lifecycleOrder(browser, after);
    for (const width of [1280, 375])
      for (const colorScheme of ["light", "dark"])
        for (const purpose of ["confirm", "delete-request"]) {
          await check(browser, before, "before", width, colorScheme, purpose);
          await check(browser, after, "after", width, colorScheme, purpose);
        }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
