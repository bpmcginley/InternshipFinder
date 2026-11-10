// Check-only lint with source-free diagnostics. Formatting is a separate command.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const position = (value) => Number.isSafeInteger(value) && value >= 1 ? value : 1;

function safePath(file) {
  const relative = path.relative(root, path.resolve(root, String(file))).replaceAll("\\", "/");
  return /^(backend|growth|scripts|worker|extension|docs\/js|tests)\/[A-Za-z0-9_./-]+\.(py|js|mjs|cjs)$/.test(relative)
    && !relative.split("/").includes("..") ? relative : "<configuration>";
}

export function sanitize(area, data) {
  if (!Array.isArray(data)) throw new Error("Invalid lint report");
  const findings = [];
  for (const item of data) {
    if (area === "python") {
      findings.push({ file: safePath(item.filename), line: position(item.location?.row),
        column: position(item.location?.column), severity: "error",
        rule: /^[A-Z]+[0-9]+$/.test(item.code) ? item.code : "syntax" });
    } else {
      if (!Array.isArray(item.messages)) throw new Error("Invalid JavaScript lint report");
      for (const message of item.messages) {
        findings.push({ file: safePath(item.filePath), line: position(message.line),
          column: position(message.column), severity: message.severity === 1 ? "warning" : "error",
          rule: /^[a-z][a-z0-9/-]+$/.test(message.ruleId) ? message.ruleId : "syntax" });
      }
    }
  }
  return findings;
}

function main() {
  try {
    const area = process.argv[2];
    if (!["python", "javascript"].includes(area) || process.argv.length !== 3) throw new Error("Invalid arguments");
    const command = area === "python" ? "python" : process.execPath;
    const args = area === "python"
      ? ["-m", "ruff", "check", "--no-cache", "--output-format", "json", "backend", "growth", "scripts"]
      : ["node_modules/eslint/bin/eslint.js", "worker", "extension", "docs/js", "tests", "--format", "json"];
    // Neither linter stream may reach the console: messages can quote existing private values.
    const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (result.error || result.signal || ![0, 1].includes(result.status)) throw new Error("Linter failed");
    const findings = sanitize(area, JSON.parse(result.stdout));
    const errors = findings.filter((item) => item.severity === "error").length;
    if (result.status !== 0 && errors === 0) throw new Error("Unusable report");
    console.log(`${area}: ${errors} lint errors, ${findings.length - errors} warnings`);
    for (const item of findings) {
      console.log(`${item.file}:${item.line}:${item.column} ${item.severity} ${item.rule}`);
    }
    process.exitCode = errors ? 1 : 0;
  } catch {
    console.error("Lint failed: check the pinned tools and configuration locally; raw diagnostics were withheld.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
