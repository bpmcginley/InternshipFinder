// Coverage-only preload. Existing VM tests omit filenames, so V8 otherwise records
// their execution as anonymous code. Attribute only byte-for-byte full sources;
// edited scripts and snippets deliberately remain unattributed.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import vm from "node:vm";

const root = fileURLToPath(new URL("../", import.meta.url));
let sources;

function sourceFiles() {
  if (sources) return sources;
  sources = new Map();
  function visit(folder) {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory() && !["test", "vendor"].includes(entry.name)) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".js")) {
        const source = readFileSync(path, "utf8");
        // Identical files cannot be attributed reliably to either original.
        sources.set(source, sources.has(source) ? null : path);
      }
    }
  }
  visit(join(root, "docs", "js"));
  visit(join(root, "extension"));
  return sources;
}

export function coverageOptions(source, options, files) {
  // Preserve explicit filenames and invalid options for the original VM to handle.
  if (options !== undefined && (options === null || typeof options !== "object")) return options;
  if (options && "filename" in options) return options;
  const filename = files.get(source);
  return filename ? { ...options, filename } : options;
}

for (const name of ["runInContext", "runInNewContext"]) {
  const original = vm[name];
  vm[name] = function (source, context, options) {
    return original.call(this, source, context, coverageOptions(source, options, sourceFiles()));
  };
}
syncBuiltinESMExports();
