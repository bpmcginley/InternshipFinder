// Browser/parser disagreement fixtures, all intercepted; Python exercises the real publisher.
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { chromium } = require(
  path.join(process.env.TEMP, "internscout-product-capture-tools/node_modules/playwright-core"),
);
const root = path.resolve(__dirname, "../../../..");
const tag = '<script defer src="/js/count.js"></script>';
const marked = tag.replace(">", ' data-employer-posting-counts="1">');
const cases = [
  ...["=", "`", "<", "\u00a0"].map((character, index) => ({
    name: `unquoted-url-${index}`,
    html: tag + `<script src=/x${character}y/../js/count.js></script>`,
    loads: 2,
  })),
  { name: "overlapping-quoted-source", html: tag + '<!-->src="' + tag + "<!-- -->", loads: 2 },
  { name: "short-comment", html: tag + "<!-->" + tag + "<!-- -->", loads: 2 },
  { name: "dash-comment", html: tag + "<!--->" + tag + "<!-- -->", loads: 2 },
  { name: "end-tag-extra", html: tag.replace("</script>", "</script extra>") + tag, loads: 2 },
  { name: "end-tag-slash", html: tag.replace("</script>", "</script/>") + tag, loads: 2 },
  {
    name: "default-short-comment",
    html: "<!-->" + marked + "<!-- -->",
    loads: 1,
    target: "index.html",
  },
  {
    name: "default-dash-comment",
    html: "<!--->" + marked + "<!-- -->",
    loads: 1,
    target: "index.html",
  },
  {
    name: "default-retained-page",
    html: "<!-->" + marked + "<!-- -->",
    loads: 1,
    target: "internships/stale/index.html",
  },
  {
    name: "annotation-retained-page",
    html: "<!--->" + marked + "<!-- -->",
    loads: 1,
    target: "internships/stale/index.html",
    flags: ["--employer-postings"],
  },
];
const code = `
import json, sys, socket
from pathlib import Path
from tempfile import TemporaryDirectory
def denied(*args, **kwargs): raise AssertionError("network forbidden")
socket.socket.connect = denied
sys.path[:0] = [sys.argv[1], sys.argv[2]]
from internscout.site.employer_capture import _mark
from internscout.site import publish
from test_employer_publication import export, tree
out = []
for case in json.load(sys.stdin):
    if "target" not in case:
        try: _mark(case["html"])
        except ValueError as error: assert "raw canonical" in str(error)
        else: raise AssertionError("unsafe stamp accepted")
    else:
        with TemporaryDirectory(prefix="internscout-p23w-grammar-") as temporary:
            site = Path(temporary)
            export(site)
            (site / "index.html").write_text('<script defer src="/js/count.js"></script>', encoding="utf-8")
            target = site / case["target"]
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(case["html"], encoding="utf-8")
            before = tree(site)
            try: publish.main(["publish", str(site), *case.get("flags", [])])
            except ValueError as error: assert "fresh unmarked publication target" in str(error)
            else: raise AssertionError("retained capture published")
            assert tree(site) == before
    out.append(True)
print(json.dumps(out))
`;
const tested = spawnSync(
  "python",
  ["-c", code, path.join(root, "backend"), path.join(root, "backend/tests")],
  {
    input: JSON.stringify(cases),
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
  },
);
assert.equal(tested.status, 0, tested.stderr);
assert.deepEqual(
  JSON.parse(tested.stdout),
  cases.map(() => true),
);
let browser;
(async () => {
  browser = await chromium.launch({
    executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    headless: true,
  });
  const results = [];
  for (const item of cases) {
    const context = await browser.newContext({ serviceWorkers: "block" });
    await context.route("**/*", (route) => {
      const url = route.request().url();
      if (url === "https://internscout.org/")
        return route.fulfill({ contentType: "text/html; charset=utf-8", body: item.html });
      assert.equal(url, "https://internscout.org/js/count.js");
      return route.fulfill({
        contentType: "text/javascript",
        body: "window.syntheticCounterLoads = (window.syntheticCounterLoads || 0) + 1;",
      });
    });
    const page = await context.newPage();
    await page.goto("https://internscout.org/");
    assert.equal(await page.evaluate(() => window.syntheticCounterLoads), item.loads);
    results.push({
      name: item.name,
      syntheticExecutions: item.loads,
      rejected: true,
      actualPublisherEntry: Boolean(item.target),
      externalRequestsAllowed: 0,
    });
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(
    path.join(__dirname, "grammar-report.json"),
    JSON.stringify(results, null, 2) + "\n",
  );
})().catch(async (error) => {
  console.error(error);
  if (browser) await browser.close();
  process.exitCode = 1;
});
