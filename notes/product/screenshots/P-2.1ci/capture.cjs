// Offline native Edge qualification. Run with NODE_PATH pointing to isolated playwright-core.
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const assert = require("node:assert/strict");
const { randomUUID, randomBytes } = require("node:crypto");
const root = path.resolve(__dirname, "../../../..");
const out = __dirname;
const credential = () => randomUUID() + "." + randomBytes(32).toString("hex");
const pageSource = fs.readFileSync(path.join(root, "docs/follows/manage.html"), "utf8");
const moduleSource = fs.readFileSync(path.join(root, "docs/js/follow-management.mjs"), "utf8");
const wrapper = `import {mountManagementPage as mount} from '/fixture-source.mjs';
export function mountManagementPage(args) {
 const key=company=>JSON.stringify({kind:'company',company});
 const row=(company,confirmed=false)=>({scope_key:key(company),created:'2026-11-12T00:00:00.000Z',confirmed_at:confirmed?'2026-11-12T01:00:00.000Z':null});
 const first=row('Example Robotics',true), second={scope_key:JSON.stringify({kind:'search',fields:['engineering','design'],states:['NY','CA']}),created:first.created,confirmed_at:null};
 window.fixture={calls:[],hold:false,status:200,removed:true,deleted:true};
 mount({...args,transport:async(kind,body,{signal})=>{
   fixture.calls.push({kind,body,signal});
   if(fixture.hold) await new Promise(r=>{fixture.release=r});
   if(fixture.status!==200) return new Response(null,{status:fixture.status});
   if(kind==='request') return new Response(null,{status:202});
   if(kind==='remove') return Response.json({removed:fixture.removed});
   if(kind==='deleteAll') return Response.json({deleted:fixture.deleted});
   return Response.json(body[1]?{scopes:[row('Zeta Research')],next:null}:{scopes:[first,second],next:second.scope_key});
 }});
}`;
(async () => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://localhost").pathname;
    res.setHeader("Referrer-Policy", "no-referrer");
    if (pathname === "/before") {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end(
        '<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>:root{color-scheme:light dark}body{font:18px system-ui;padding:32px}</style><title>404</title></head><body><h1>404</h1><p>Page not found.</p></body></html>',
      );
      return;
    }
    if (pathname === "/follows/manage.html") {
      res.setHeader("Content-Type", "text/html");
      res.end(pageSource);
      return;
    }
    if (pathname === "/js/follow-management.mjs" || pathname === "/fixture-source.mjs") {
      res.setHeader("Content-Type", "text/javascript");
      res.end(pathname === "/fixture-source.mjs" ? moduleSource : wrapper);
      return;
    }
    if (pathname === "/away") {
      res.end(
        "<!doctype html><html><title>Away</title><p>Offline lifecycle destination.</p></html>",
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
    ignoreDefaultArgs: ["--disable-back-forward-cache"],
  });
  let cases = 0;
  const results = [];
  try {
    for (const width of [1280, 375])
      for (const theme of ["light", "dark"]) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: theme,
        });
        await context.route("**/*", (route) =>
          new URL(route.request().url()).origin === base ? route.continue() : route.abort(),
        );
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (e) => errors.push(e.message));
        await page.goto(base + "/before");
        await page.screenshot({
          path: path.join(out, `before-${width}-${theme}.png`),
          fullPage: true,
        });
        await page.goto(base + "/follows/manage.html#token=" + credential());
        await page.waitForFunction(() => !!window.fixture);
        assert.equal(new URL(page.url()).hash, "");
        assert.equal(await page.evaluate(() => fixture.calls.length), 0);
        await page.screenshot({
          path: path.join(out, `after-initial-${width}-${theme}.png`),
          fullPage: true,
        });
        await page.locator("#load").focus();
        await page.keyboard.press("Enter");
        await page.locator("#scopes li").nth(1).waitFor();
        assert.equal(await page.locator("#scopes li").count(), 2);
        assert(await page.evaluate(() => document.activeElement.className === "scope"));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        const bounds = await page.locator("button:not([hidden]),input").evaluateAll((nodes) =>
          nodes.map((n) => ({
            height: n.getBoundingClientRect().height,
            width: n.getBoundingClientRect().width,
          })),
        );
        assert(bounds.every((b) => b.height >= 44));
        await page.screenshot({
          path: path.join(out, `after-list-${width}-${theme}.png`),
          fullPage: true,
        });
        await page.locator("#more").click();
        await page.waitForFunction(() => document.querySelectorAll("#scopes li").length === 3);
        assert.equal(await page.locator("#scopes li").count(), 3);
        await page.evaluate(() => (fixture.removed = false));
        await page.locator("#scopes button").first().click();
        await page.waitForFunction(() =>
          document.querySelector("#status").textContent.includes("unavailable"),
        );
        assert.equal(await page.locator("#scopes li").count(), 3);
        await page.evaluate(() => (fixture.removed = true));
        await page.locator("#scopes button").first().click();
        await page.waitForFunction(
          () => document.querySelector("#status").textContent === "Follow removed.",
        );
        assert.equal(await page.locator("#scopes li").count(), 2);
        assert(
          await page.evaluate(
            () => document.activeElement === document.querySelector("#scopes button"),
          ),
        );
        await page.evaluate(() => (fixture.hold = true));
        await page.locator("#load").click();
        const replacement = credential();
        await page.evaluate((t) => {
          location.hash = "#token=" + t;
        }, replacement);
        await page.waitForFunction(() => !location.hash);
        await page.evaluate(() => fixture.release());
        await page.waitForTimeout(30);
        assert.equal(await page.locator("#scopes li").count(), 0);
        await page.evaluate(() => (fixture.hold = false));
        await page.locator("#load").click();
        await page.locator("#scopes li").nth(1).waitFor();
        assert(await page.evaluate((t) => fixture.calls.at(-1).body[0] === t, replacement));
        await page.locator(".skip").focus();
        await page.keyboard.press("Enter");
        assert.equal(new URL(page.url()).hash, "#main");
        await page.evaluate(() => (fixture.hold = true));
        await page.locator("#load").click();
        await page.evaluate((t) => {
          location.hash = "#token=" + t;
          dispatchEvent(new PageTransitionEvent("pagehide"));
          fixture.release();
          dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
        }, credential());
        await page.waitForTimeout(30);
        assert.equal(await page.locator("#load").isDisabled(), true);
        assert.equal(await page.locator("#scopes li").count(), 0);
        assert.equal(new URL(page.url()).hash, "");
        await page.evaluate(() => (fixture.hold = false));
        await page.locator("#email").fill("reader@example.test");
        await page.locator("#request-button").click();
        await page.waitForFunction(() =>
          document.querySelector("#status").textContent.includes("management link is on its way"),
        );
        assert.equal(await page.locator("#email").inputValue(), "");
        const reissue = credential();
        await page.evaluate((t) => (location.hash = "#token=" + t), reissue);
        await page.waitForFunction(() => !location.hash);
        await page.locator("#load").click();
        await page.locator("#delete").click();
        await page.waitForFunction(() =>
          document.querySelector("#status").textContent.includes("have been deleted"),
        );
        assert.equal(await page.locator("#load").isDisabled(), true);
        assert.deepEqual(errors, []);
        cases += 10;
        results.push({
          width,
          theme,
          minControlHeight: Math.min(...bounds.map((b) => b.height)),
          horizontalOverflow: false,
        });
        await context.close();
      }
    // A fresh context without request interception exercises actual BFCache restoration.
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(base + "/follows/manage.html#token=" + credential());
    await page.waitForFunction(() => !!window.fixture);
    await page.evaluate(() => {
      window.restored = false;
      addEventListener("pageshow", (e) => {
        window.restored = e.persisted;
      });
    });
    await page.goto(base + "/away");
    await page.evaluate(() => history.back());
    await page.waitForFunction(() => window.restored === true);
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => window.restored), true);
    assert.equal(await page.locator("#load").isDisabled(), true);
    assert.equal(await page.evaluate(() => fixture.calls.length), 0);
    cases++;
    await context.close();
    console.log(
      JSON.stringify({
        cases,
        results,
        bfcache: "persisted, inert",
        network: "local server only; synthetic transport",
        screenshots: 12,
      }),
    );
  } finally {
    await browser.close();
    await new Promise((r) => server.close(r));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
