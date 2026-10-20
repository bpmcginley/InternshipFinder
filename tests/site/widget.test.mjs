import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync(new URL("../../docs/widget/index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const role = (id, fields = ["civil"], over = {}) => ({ id, title: "Civil engineering intern", company_name: "Example",
  location: "Boston, MA", apply_url: `https://careers.example/${id}`, field_tags: fields, stage: ["internship"], ...over });
const feed = (rows = [role("civil-1")], over = {}) => ({ schema: 1, generated_at: "2026-10-19T18:00:00+00:00",
  per_field: 12, total: rows.length, counts: { civil: rows.length }, rows, ...over });
const tick = async () => { for (let i = 0; i < 15; i++) await new Promise(setImmediate); };

function widget({ query = "?field=civil-engineering", fetcher = async () => Response.json(feed()), expire = false } = {}) {
  const els = new Map();
  const get = (id) => {
    if (!els.has(id)) els.set(id, { innerHTML: "", textContent: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
    return els.get(id);
  };
  get("isw").attrs["aria-busy"] = "true";
  get("isw-list").innerHTML = "Loading open internships.";
  const calls = [];
  const context = { document: { getElementById: get }, window: { location: { search: query } },
    URLSearchParams, TextDecoder, AbortController,
    fetch: (url, options) => { calls.push({ url, options }); return fetcher(url, options); },
    setTimeout: (fn) => expire ? setTimeout(fn, 0) : setTimeout(fn, 1000), clearTimeout };
  vm.runInNewContext(script, context);
  return { get, calls };
}

test("a field absent from first.json loads its real complete-corpus feed", async () => {
  const w = widget();
  assert.equal(w.get("isw").attrs["aria-busy"], "true");
  assert.match(w.get("isw-list").innerHTML, /Loading/);
  await tick();
  assert.deepEqual(w.calls.map((c) => c.url), ["../data/widget.json"]);
  assert.ok(w.calls[0].options.signal);
  assert.match(w.get("isw-list").innerHTML, /Civil engineering intern/);
  assert.doesNotMatch(w.get("isw-list").innerHTML, /No open roles/);
  assert.equal(w.get("isw").attrs["aria-busy"], "false");
  assert.match(w.get("isw-foot").innerHTML, /Search all 1 open roles/);
});

test("only a verified complete empty field gets an empty state; nursing uses its own tag", async () => {
  const empty = widget({ fetcher: async () => Response.json(feed([], { counts: {} })) });
  const nurse = widget({ query: "?field=nursing", fetcher: async () => Response.json(feed([role("n1", ["nursing"])], { counts: { nursing: 1 } })) });
  await tick();
  assert.match(empty.get("isw-list").innerHTML, /No open roles/);
  assert.match(nurse.get("isw-list").innerHTML, /Civil engineering intern/);
});

test("network, malformed, incomplete and oversized feeds show errors, not false empty results", async () => {
  const cases = [
    async () => { throw new Error("offline"); },
    async () => new Response("bad JSON"),
    async () => Response.json({ rows: [] }),
    async () => Response.json(feed([], { total: 10, counts: { civil: 10 } })),
    async () => Response.json(feed([role("c1")], { counts: { civil: 2 }, total: 2 })),
    async () => new Response("{}", { headers: { "Content-Length": "2097153" } }),
    async () => new Response(" ".repeat(2097153)),
  ];
  for (const fetcher of cases) {
    const w = widget({ fetcher });
    await tick();
    assert.match(w.get("isw-list").innerHTML, /Could not load the full listings/);
    assert.doesNotMatch(w.get("isw-list").innerHTML, /No open roles/);
    assert.equal(w.get("isw").attrs["aria-busy"], "false");
  }
});

test("a request that exceeds the deadline aborts and leaves a useful error", async () => {
  const w = widget({ expire: true, fetcher: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")));
  }) });
  await new Promise((r) => setTimeout(r, 15));
  await tick();
  assert.equal(w.calls[0].options.signal.aborted, true);
  assert.match(w.get("isw-list").innerHTML, /Could not load the full listings/);
});

test("output limits and text escaping remain intact", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => role(String(i), ["civil"], { title: `<img src=x onerror=alert(1)> ${i}` }));
  const w = widget({ query: "?field=civil&limit=3", fetcher: async () => Response.json(feed(rows)) });
  await tick();
  assert.equal((w.get("isw-list").innerHTML.match(/class="isw-job"/g) || []).length, 3);
  assert.match(w.get("isw-list").innerHTML, /&lt;img/);
  assert.doesNotMatch(w.get("isw-list").innerHTML, /<img/);
});
