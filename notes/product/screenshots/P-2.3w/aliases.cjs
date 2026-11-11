// Native Edge URL resolution plus the actual Python publisher guard; all traffic intercepted.
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { chromium } = require(
  path.join(process.env.TEMP, "internscout-product-capture-tools/node_modules/playwright-core"),
);
const root = path.resolve(__dirname, "../../../..");
const aliases = [
  "https:///internscout.org/js/count.js",
  "https:////internscout.org/js/count.js",
  "////internscout.org/js/count.js",
  "https://%69nternscout.org/js/count.js",
  "https://internscout%2eorg/js/count.js",
  "https://ｉnternscout.org/js/count.js",
];
const code = `
import json, sys
sys.path.insert(0, sys.argv[1])
from internscout.site.employer_capture import _mark
results = []
for alias in json.load(sys.stdin):
    text = '<script defer src="/js/count.js"></script><script defer src="' + alias + '"></script>'
    try:
        _mark(text)
        results.append(False)
    except ValueError:
        results.append(True)
print(json.dumps(results))
`;
const tested = spawnSync("python", ["-c", code, path.join(root, "backend")], {
  input: JSON.stringify(aliases),
  encoding: "utf-8",
  env: Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) =>
        ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC"].includes(key.toUpperCase()),
      )
      .concat([
        ["PYTHONUTF8", "1"],
        ["PYTHONDONTWRITEBYTECODE", "1"],
      ]),
  ),
});
assert.equal(tested.status, 0, tested.stderr);
assert.deepEqual(
  JSON.parse(tested.stdout),
  aliases.map(() => true),
);
let browser;
(async () => {
  browser = await chromium.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  const results = [];
  for (const alias of aliases) {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const requests = [];
    await context.route("**/*", (route) => {
      const url = route.request().url();
      requests.push(url);
      if (url === "https://internscout.org/")
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<script defer src="/js/count.js"></script><script defer src="${alias}"></script>`,
        });
      assert.equal(url, "https://internscout.org/js/count.js");
      return route.fulfill({
        contentType: "text/javascript",
        body: "window.syntheticCounterLoads = (window.syntheticCounterLoads || 0) + 1;",
      });
    });
    const page = await context.newPage();
    await page.goto("https://internscout.org/");
    const actual = await page.evaluate(() => ({
      loads: window.syntheticCounterLoads,
      urls: [...document.scripts].map((s) => s.src),
    }));
    assert.deepEqual(actual, {
      loads: 2,
      urls: ["https://internscout.org/js/count.js", "https://internscout.org/js/count.js"],
    });
    results.push({
      alias,
      resolved: actual.urls[1],
      syntheticExecutions: actual.loads,
      publisherRejected: true,
      externalRequestsAllowed: 0,
    });
    assert(requests.length >= 2);
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(
    path.join(__dirname, "alias-report.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
})().catch(async (error) => {
  console.error(error);
  if (browser) await browser.close();
  process.exitCode = 1;
});
