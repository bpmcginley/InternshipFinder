import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const read = name => fs.readFileSync(new URL(`../../docs/${name}`, import.meta.url), "utf8");

test("privacy and terms use their sitemap URLs for canonical and link previews", () => {
  for (const [file, path] of [["privacy.html", "privacy"], ["terms.html", "terms"]]) {
    const source = read(file);
    const url = `https://internscout.org/${path}`;
    assert.equal(source.match(/<link rel="canonical"/g)?.length, 1, file);
    assert.match(source, new RegExp(`<link rel="canonical" href="${url}"/>`));
    assert.match(source, new RegExp(`<meta property="og:url" content="${url}"/>`));
    assert.doesNotMatch(source, new RegExp(`(?:canonical|og:url)[^>]+${path}\\.html`));
  }
});
