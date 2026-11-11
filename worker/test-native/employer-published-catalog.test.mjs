import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { build } from "esbuild";
import { Miniflare, Response, convertV4MiniflareOptions } from "miniflare";

// Native workerd fetch, with every outbound request intercepted locally. No external I/O.
test("native fetch refreshes published membership and refuses redirects in both modes", async () => {
  const catalog = "https://internscout.org/data/employer-posting-keys.json";
  const result = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL("../", import.meta.url)),
      contents: `
        import { createEmployerPostingRuntime } from './src/employer-posting-runtime.js';
        import { admitEmployerPosting } from './src/employer-posting-counts.js';
        let time = 0;
        const runtime = createEmployerPostingRuntime({clock: () => time});
        export default { async fetch(request, env) {
          const value = await request.json();
          time = value.at;
          const now = () => new Date(time);
          const service = runtime.service({
            EMPLOYER_POSTING_COUNTS_ENABLED: '1',
            EMPLOYER_POSTING_CATALOG: JSON.stringify(value.descriptor)
          }, env.DB, fetch, now);
          const receipt = await admitEmployerPosting(
            {e:'employer_posting_open',c:value.key}, '2001:db8::123', now());
          return Response.json(await service(receipt));
        }};`,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
  });
  let body = '["alpha"]',
    status = 200;
  const requests = [];
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      name: "probe",
      cf: false,
      modules: true,
      script: result.outputFiles[0].text,
      compatibilityDate: "2026-09-01",
      d1Databases: ["DB"],
      outboundService(request) {
        requests.push({ url: request.url, method: request.method });
        return new Response(body, {
          status,
          headers: status === 302 ? { Location: "https://never-follow.invalid/" } : {},
        });
      },
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    const sql = await readFile(
      new URL("../migrations/0011_employer_posting_counts.sql", import.meta.url),
      "utf8",
    );
    for (const statement of sql.split(";").filter((s) => s.trim()))
      await db.prepare(statement).run();
    await db.prepare("INSERT INTO employer_posting_day_caps VALUES(date('now'),0)").run();
    const day = (await db.prepare("SELECT date('now') AS day").first()).day;
    let at = Date.parse(day + "T00:00:00Z");
    const published = { mode: "published", url: catalog };
    const count = async (key, descriptor = published) => {
      const response = await mf.dispatchFetch("https://local.invalid/", {
        method: "POST",
        body: JSON.stringify({ key, descriptor, at }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.equal(await count("alpha"), true);
    body = '["beta"]';
    at += 300000;
    assert.equal(await count("alpha"), false);
    assert.equal(await count("beta"), true);
    assert.equal(requests.length, 2);
    status = 302;
    at += 300000;
    assert.equal(await count("beta"), false);
    assert.equal(requests.length, 3, "redirect is not followed");
    const pinned = {
      url: catalog,
      version: "a".repeat(40),
      sha256: createHash("sha256").update(body).digest("hex"),
    };
    assert.equal(await count("beta", pinned), false);
    assert.equal(requests.length, 4, "pinned redirect is not followed");
    status = 200;
    at += 5000;
    assert.equal(await count("beta", pinned), true);
    assert.equal(requests.length, 5);
    assert.deepEqual(
      requests.map((r) => r.url),
      [
        catalog,
        catalog,
        catalog,
        catalog + "?v=" + pinned.version,
        catalog + "?v=" + pinned.version,
      ],
    );
    assert.ok(requests.every((r) => r.method === "GET"));
  } finally {
    await mf.dispose();
  }
});
