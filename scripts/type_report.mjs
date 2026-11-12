// Report existing type debt without exposing diagnostic messages or source literals.
// Type errors are report-only. Tool failures and invalid reports still fail CI.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const position = (value) => Number.isSafeInteger(value) && value >= 1 ? value : 1;

const pythonFiles = /^(backend\/internscout|growth|worker\/src)\/[A-Za-z0-9_./-]+\.(py|js)$/;
const javascriptProjects = {
  worker: {
    config: "worker/jsconfig.json",
    files: /^worker\/src\/[A-Za-z0-9_./-]+\.js$/,
  },
  site: {
    config: "jsconfig.site.json",
    files: /^docs\/(?:js\/(?!(?:app-modules|buy-modules|modules)\/)|widget\/)[A-Za-z0-9_./-]+\.(?:js|mjs)$/,
  },
  extension: {
    config: "jsconfig.extension.json",
    files: /^extension\/(?!(?:test|vendor|node_modules)\/)[A-Za-z0-9_./-]+\.(?:js|mjs)$/,
  },
};

function safeFile(file, allowedFiles) {
  const relative = path.relative(root, path.resolve(root, String(file))).replaceAll("\\", "/");
  return allowedFiles.test(relative)
    && !relative.split("/").includes("..") ? relative : "<configuration>";
}

export function pythonDiagnostics(report) {
  if (!Array.isArray(report.generalDiagnostics) || !report.summary) throw new Error("Invalid report");
  return report.generalDiagnostics.map((item) => ({
    file: safeFile(item.file, pythonFiles),
    line: position(item.range?.start?.line + 1),
    column: position(item.range?.start?.character + 1),
    severity: ["error", "warning", "information"].includes(item.severity) ? item.severity : "error",
    rule: /^report[A-Za-z]+$/.test(item.rule) ? item.rule : "unspecified",
  }));
}

export function javascriptDiagnostics(output, area) {
  if (!Object.hasOwn(javascriptProjects, area)) throw new Error("Unknown area");
  const diagnostics = [];
  for (const line of output.split(/\r?\n/)) {
    // Discard the complete message, including continuation lines and literal values.
    const match = /^(.*?)\((\d+),(\d+)\): error TS(\d+):/.exec(line);
    if (match) {
      const file = safeFile(match[1], javascriptProjects[area].files);
      if (file === "<configuration>" || (area !== "worker" && file.endsWith(".min.js"))) {
        throw new Error("Unexpected diagnostic path");
      }
      diagnostics.push({ file, line: position(Number(match[2])), column: position(Number(match[3])),
        severity: "error", rule: `TS${match[4]}` });
    } else if (/^error TS\d+:/.test(line)) {
      throw new Error("Compiler configuration failure");
    }
  }
  return diagnostics;
}

export function summarize(tool, diagnostics) {
  return {
    tool,
    mode: "report-only",
    errors: diagnostics.filter((item) => item.severity === "error").length,
    warnings: diagnostics.filter((item) => item.severity === "warning").length,
    information: diagnostics.filter((item) => item.severity === "information").length,
    diagnostics,
  };
}

function check(area) {
  const python = area === "python";
  if (!python && !Object.hasOwn(javascriptProjects, area)) throw new Error("Unknown area");
  const args = python
    ? ["node_modules/pyright/index.js", "--project", "pyrightconfig.json", "--outputjson"]
    : ["node_modules/typescript/bin/tsc", "--project", javascriptProjects[area].config, "--pretty", "false"];
  // Never inherit stdout/stderr: checkers can echo private literals from existing source.
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error || result.signal || ![0, 1, 2].includes(result.status)) throw new Error("Checker failed");
  if (python && result.status === 2) throw new Error("Python configuration failure");
  const diagnostics = python ? pythonDiagnostics(JSON.parse(result.stdout)) : javascriptDiagnostics(result.stdout, area);
  if (result.status !== 0 && diagnostics.length === 0) throw new Error("No usable diagnostics");
  return summarize(python ? "pyright" : "typescript", diagnostics);
}

function main() {
  try {
    const [area, option, destination] = process.argv.slice(2);
    if (option && (option !== "--output" || !destination)) throw new Error("Invalid arguments");
    const report = check(area);
    if (destination) {
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, JSON.stringify(report, null, 2) + "\n");
    }
    console.log(`${report.tool}: ${report.errors} errors, ${report.warnings} warnings, ${report.information} information (report-only)`);
  } catch {
    // No exception message or stack: a checker/tool error may include source or local identifiers.
    console.error("Type report failed: check the pinned tool installation and configuration locally; raw diagnostics were withheld.");
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
