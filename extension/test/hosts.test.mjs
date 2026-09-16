// Host permissions: what the manifest grants at install, and what is asked for one site at a time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ATS_HOSTS, ATS_MATCHES, originPattern, hostOf, isAtsHost, hasHostAccess, requestHostAccess } from "../lib/hosts.js";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));

test("the manifest grants exactly the ATS list, and <all_urls> only as optional", () => {
  assert.deepEqual(manifest.host_permissions, ATS_MATCHES);
  assert.deepEqual(manifest.optional_host_permissions, ["<all_urls>"]);
  // The install-time warning is the whole point: if <all_urls> ever creeps back into host_permissions,
  // every student sees "read and change all your data on all websites" before the product does anything.
  assert.ok(!manifest.host_permissions.includes("<all_urls>"));
});

test("real board hostnames fall inside the granted patterns", () => {
  // Taken from the live listing data; every one of these is a subdomain, which is what "*." covers.
  for (const h of ["boeing.wd1.myworkdayjobs.com", "job-boards.greenhouse.io", "jobs.ashbyhq.com",
                   "jobs.lever.co", "careers-sig.icims.com", "textron.taleo.net",
                   "egug.fa.us2.oraclecloud.com", "jobs.smartrecruiters.com", "apply.workable.com"]) {
    assert.ok(isAtsHost(`https://${h}/job/1`), h);
  }
  // Employer-run careers sites are the case the optional permission exists for
  for (const h of ["www.tesla.com", "amazon.jobs", "cityjobs.nyc.gov", "johndeere.eightfold.ai"]) {
    assert.ok(!isAtsHost(`https://${h}/job/1`), h);
  }
  assert.equal(ATS_HOSTS.length, new Set(ATS_HOSTS).size, "no duplicate domains");
});

test("we ask for one host, never for everything", () => {
  assert.equal(originPattern("https://www.tesla.com/careers/search/job/123?x=1#y"), "https://www.tesla.com/*");
  assert.equal(originPattern("http://localhost:8000/x"), "http://localhost/*");
  assert.equal(originPattern("file:///C:/resume.pdf"), null);
  assert.equal(originPattern("not a url"), null);
  assert.equal(hostOf("https://amazon.jobs/en/jobs/1"), "amazon.jobs");
  assert.equal(hostOf("nonsense"), "");
});

test("access check asks about that one origin, and a broken URL never blocks a job", async () => {
  const asked = [];
  const perms = { contains: async (p) => { asked.push(p); return true; }, request: async (p) => { asked.push(p); return true; } };
  assert.equal(await hasHostAccess("https://amazon.jobs/en/jobs/1", perms), true);
  assert.deepEqual(asked, [{ origins: ["https://amazon.jobs/*"] }]);

  assert.equal(await requestHostAccess("https://amazon.jobs/x", perms), true);
  assert.equal(await requestHostAccess("file:///x", perms), false);
  // A URL we cannot parse is not a permission problem, so it must not become one: let the run start and
  // let injection report the real error.
  assert.equal(await hasHostAccess("nonsense", perms), true);

  // Chrome throwing (a pattern it dislikes) must read as "not granted", not as an unhandled rejection
  const angry = { contains: async () => { throw new Error("nope"); }, request: async () => { throw new Error("nope"); } };
  assert.equal(await hasHostAccess("https://amazon.jobs/x", angry), false);
  assert.equal(await requestHostAccess("https://amazon.jobs/x", angry), false);
});
