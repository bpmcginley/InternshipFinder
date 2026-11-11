// Reproduce the dormant limiter's idle-erasure blocker in local workerd, without real IPs/network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
let outbound = 0;
const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), "utf8");
const mf = new Miniflare(
  convertV4MiniflareOptions({
    name: "idle-budget-probe",
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
    let fires=0;
    const budget=createEmployerMinuteBudget((fn,ms)=>setTimeout(()=>{fires++;fn();},ms));
    const at=new Date('2027-03-01T00:00:59.980Z');
    export default {fetch(request) {
      const path=new URL(request.url).pathname;
      if(path==='/fill') {
        let accepted=0;for(let i=0;i<30;i++)if(budget('192.0.2.201',at))accepted++;
        return Response.json({accepted,extra:budget('192.0.2.201',at),fires});
      }
      if(path==='/status')return Response.json({fires});
      if(path==='/same-synthetic-minute')return Response.json({accepted:budget('192.0.2.201',at),fires});
      return Response.json({accepted:budget('192.0.2.201',new Date(at.getTime()+20)),fires});
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
  assert.deepEqual(await call("fill"), { accepted: 30, extra: false, fires: 0 });
  // Wait outside the returned request for much longer than its scheduled 20ms expiry.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(await call("status"), { fires: 0 });
  assert.deepEqual(await call("same-synthetic-minute"), { accepted: false, fires: 0 });
  assert.deepEqual(await call("next-minute"), { accepted: true, fires: 0 });
  assert.equal(outbound, 0);
  console.log(
    "REPRODUCED privacy blocker: owner request ended; 20ms idle timer never fired after 150ms; later synthetic same-minute probe retains exhausted entry; next-minute access clears it. Zero outbound requests.",
  );
} finally {
  await mf.dispose();
}
