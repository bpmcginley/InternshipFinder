// Local workerd request ownership probe. No real catalog, network or production bindings.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
let outbound = 0;
const mf = new Miniflare(
  convertV4MiniflareOptions({
    name: "probe",
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
    import {createRequestSafeEmployerCatalogCache} from './cache.js';
    let loads=0, entered=false;
    const cache=createRequestSafeEmployerCatalogCache({maxBytes:64,loadTimeoutMs:2000,
      parse:text=>{const keys=JSON.parse(text);return key=>keys.includes(key);}});
    export default {async fetch(request) {
      if(new URL(request.url).pathname==='/state') return Response.json({entered,loads});
      const accepted=await cache.has('acme', async signal=>{
        loads++; entered=true;
        return new Response(new ReadableStream({async start(controller) {
          await new Promise(resolve=>setTimeout(resolve,250));
          if(signal.aborted) throw Error('Another request aborted the owner');
          controller.enqueue(new TextEncoder().encode('["acme"]'));controller.close();
        }}));
      });
      return Response.json({accepted,loads});
    }};
  `,
      },
      {
        type: "ESModule",
        path: "cache.js",
        contents: readFileSync(
          new URL("../src/employer-catalog-cache.js", import.meta.url),
          "utf8",
        ),
      },
    ],
  }),
);
try {
  await mf.ready;
  const owner = mf.dispatchFetch("https://local.test/owner");
  let entered = false;
  for (let i = 0; i < 100; i++) {
    entered = (await (await mf.dispatchFetch("https://local.test/state")).json()).entered;
    if (entered) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(entered, true);
  const competing = await (await mf.dispatchFetch("https://local.test/competing")).json();
  assert.deepEqual(competing, { accepted: false, loads: 1 });
  assert.deepEqual(await (await owner).json(), { accepted: true, loads: 1 });
  assert.deepEqual(await (await mf.dispatchFetch("https://local.test/reuse")).json(), {
    accepted: true,
    loads: 1,
  });
  assert.equal(outbound, 0);
  console.log(
    "PASS local workerd: concurrent request rejects; owner stream completes; parsed membership reused; zero outbound requests.",
  );
} finally {
  await mf.dispose();
}
