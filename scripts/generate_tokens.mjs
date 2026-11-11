import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SOURCE = new URL("../tokens.css", import.meta.url);
const TARGETS = [
  "docs/index.html",
  "docs/employers/index.html",
  "docs/employers/buy/index.html",
  "backend/internscout/site/assets.py",
  "extension/lib/theme.css",
];

const LIGHT = ":root{";
const DARK = "@media (prefers-color-scheme:dark){:root{";
const TOUCH = "@media (pointer:coarse){:root{";
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const span = new RegExp(
  "^ *" + literal(LIGHT) + "([^{}]+)\\}\\r?\\n" +
  " *" + literal(DARK) + "([^{}]+)\\}\\}\\r?\\n" +
  " *" + literal(TOUCH) + "([^{}]+)\\}\\}",
  "gm",
);

function findBlock(css, file) {
  const blocks = [...css.matchAll(span)];
  if (blocks.length !== 1) throw new Error(`Expected one design token block in ${file}`);
  return blocks[0];
}

function compactBody(body, breakBefore) {
  const flat = body.split("\n").map((line) => line.trim()).join("").replace(/;$/, "");
  // Retain the historical line wrap in the four compact copies.
  return breakBefore ? flat.replace(`;${breakBefore}:`, `;\n${breakBefore}:`) : flat;
}

export function updateTokenCopies({ write = false } = {}) {
  const source = findBlock(readFileSync(SOURCE, "utf8"), "tokens.css");
  const [light, dark, touch] = source.slice(1).map((body) => body.replaceAll("\r\n", "\n"));
  const dashboard = source[0].replaceAll("\r\n", "\n").split("\n").map((line) => "  " + line).join("\n");
  const compact = [
    LIGHT + compactBody(light, "--serif") + "}",
    DARK + compactBody(dark, "--i-select") + "}}",
    TOUCH + compactBody(touch) + "}}",
  ].join("\n");

  const updates = [];
  for (const path of TARGETS) {
    const file = new URL("../" + path, import.meta.url);
    const text = readFileSync(file, "utf8");
    const block = findBlock(text, path);
    const output = path === "docs/index.html" ? dashboard : compact;
    const replacement = block[0].includes("\r\n") ? output.replaceAll("\n", "\r\n") : output;
    if (block[0] === replacement) continue;
    const content = text.slice(0, block.index) + replacement + text.slice(block.index + block[0].length);
    updates.push({ path, file, content });
  }
  // Validate every target before applying any replacements.
  if (write) {
    for (const { file, content } of updates) writeFileSync(file, content);
  }
  return updates.map(({ path }) => path);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) {
    console.error("Usage: node scripts/generate_tokens.mjs [--check]");
    process.exitCode = 2;
  } else {
    const check = args.includes("--check");
    const stale = updateTokenCopies({ write: !check });
    for (const path of stale) console[check ? "error" : "log"](`${check ? "Stale" : "Updated"}: ${path}`);
    if (check && stale.length) process.exitCode = 1;
  }
}
