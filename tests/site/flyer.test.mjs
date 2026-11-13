import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../../docs/js/flyer.js", import.meta.url), "utf8");
const context = vm.createContext({});
vm.runInContext(source, context);
const { campusTag, flyerUrl } = context.ISFlyer;

test("campus tags fit the existing bounded flyer channel grammar", () => {
  for (const name of [
    "",
    "UMass Amherst",
    "École Montréal",
    "中文",
    "<script>alert(1)</script>",
    "A".repeat(100),
  ]) {
    const url = new URL(flyerUrl(name));
    assert.equal(url.origin, "https://internscout.org");
    assert.equal(url.pathname, "/");
    assert.match(url.searchParams.get("utm_source"), /^flyer(-[a-z0-9]{1,16})?$/);
    assert.equal(url.searchParams.get("utm_medium"), "print");
    assert.deepEqual([...url.searchParams.keys()], ["utm_source", "utm_medium"]);
  }
  assert.equal(campusTag("UMass Amherst"), "umassamherst");
  assert.equal(campusTag("École Montréal"), "ecolemontreal");
  assert.equal(campusTag("A".repeat(100)), "a".repeat(16));
});

test("bundled QR encoder handles longest flyer URLs with a four-module quiet zone", () => {
  vm.runInContext(
    fs.readFileSync(new URL("../../docs/js/qrcode.min.js", import.meta.url), "utf8"),
    context,
  );
  const qr = context.qrcode(0, "M");
  qr.addData(flyerUrl("a".repeat(80)), "Byte");
  qr.make();
  const svg = qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true });
  const side = qr.getModuleCount() * 4 + 32;
  assert.match(svg, new RegExp(`viewBox="0 0 ${side} ${side}"`));
  assert.match(svg, /<svg/);
  assert.doesNotMatch(svg, /<script|(?:href|src)=["']https?:/);
});

test("flyer script has no campus persistence or remote QR dependency", () => {
  assert.doesNotMatch(source, /localStorage|sessionStorage|fetch\(|sendBeacon\(/);
  assert.match(source, /\.textContent = name/);
  const html = fs.readFileSync(new URL("../../docs/flyer.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /<script[^>]+src=["']https?:/);
  assert.match(html, /@media print/);
  assert.match(html, /aria-describedby="campus-help"/);
  assert.match(html, /id="print"[^>]+disabled/);
});
