// Local workerd multi-request budget regression; synthetic addresses only, no network or timers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
let outbound = 0;
const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const mf = new Miniflare(
  convertV4MiniflareOptions({
    name: "hmac-budget-probe",
    compatibilityDate: "2026-09-01",
    cf: false,
    outboundService: () => {
      outbound++;
      throw Error("External requests forbidden");
    },
    modules: [
      {
        type: "ESModule",
        path: "probe.mjs",
        contents: `
    import {createEmployerMinuteBudget} from './employer-posting-counts.js';
    const budget=createEmployerMinuteBudget();
    const start=Date.parse('2027-03-01T00:00:59.980Z');let clock=start;
    globalThis.setTimeout=()=>{throw Error('Limiter must not depend on runtime timers');};
    globalThis.clearTimeout=()=>{throw Error('Limiter must not cancel runtime timers');};
    export default {async fetch(request) {
      const path=new URL(request.url).pathname;
      if(path==='/advance')clock=start+20;
      const at=new Date(path==='/old'?start:clock);
      const address=path==='/other'?'192.0.2.202':'192.0.2.201';
      return Response.json({accepted:await budget(address,at)});
    }};
  `,
      },
      ...["employer-posting-counts.js", "employer-catalog-cache.js"].map((name) => ({
        type: "ESModule",
        path: name,
        contents: source(name),
      })),
    ],
  }),
);
try {
  const call = async (path) => (await mf.dispatchFetch(`https://local.test/${path}`)).json();
  await mf.ready;
  const concurrent = await Promise.all(Array.from({ length: 40 }, () => call("same")));
  assert.equal(concurrent.filter((result) => result.accepted === true).length, 30);
  assert.deepEqual(await call("other"), { accepted: true });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(await call("same"), { accepted: false });
  assert.deepEqual(await call("advance"), { accepted: true });
  assert.deepEqual(await call("old"), { accepted: false });
  for (let i = 1; i < 30; i++) assert.deepEqual(await call("same"), { accepted: true });
  assert.deepEqual(await call("same"), { accepted: false });
  assert.equal(outbound, 0);
  console.log(
    "PASS local workerd: 40 independent concurrent requests admit exactly 30; separate address remains independent; UTC rollover admits a fresh 30; older minute fails closed; throwing timer stubs never invoked; zero outbound requests. Opaque codes use lazy expiry, not idle erasure.",
  );
} finally {
  await mf.dispose();
}
