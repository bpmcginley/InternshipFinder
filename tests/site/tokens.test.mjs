// tokens.css owns the shared light, dark and touch rules. The generated copies stay inline.
// The existing design checks cover WCAG AA, type and controls, plus the local overlay subset.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { updateTokenCopies } from "../../scripts/generate_tokens.mjs";

test("the generated token blocks are current with tokens.css", () => {
  assert.deepEqual(updateTokenCopies(), [], "run node scripts/generate_tokens.mjs");
});

function withTokenFixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "internscout-tokens-"));
  const script = "scripts/generate_tokens.mjs";
  const targets = [
    "docs/index.html",
    "docs/employers/index.html",
    "docs/employers/buy/index.html",
    "backend/internscout/site/assets.py",
    "extension/lib/theme.css",
  ];
  try {
    for (const path of [script, "tokens.css", ...targets]) {
      const file = join(dir, path);
      mkdirSync(dirname(file), { recursive: true });
      copyFileSync(new URL("../../" + path, import.meta.url), file);
    }
    run(dir, script, targets);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the generator validates the last target before writing any files", () => {
  withTokenFixture((dir, script, targets) => {
    const source = join(dir, "tokens.css");
    const original = readFileSync(source, "utf8");
    const edited = original.replace(/--paper:[^;]+;/, "--paper:#010203;");
    assert.notEqual(edited, original);
    writeFileSync(source, edited);

    const last = join(dir, targets.at(-1));
    const theme = readFileSync(last, "utf8");
    const invalid = theme.replace("@media (pointer:coarse){:root{", "@media (pointer:coarse){body{");
    assert.notEqual(invalid, theme);
    writeFileSync(last, invalid);

    const before = targets.map((path) => readFileSync(join(dir, path)));
    const result = spawnSync(process.execPath, [join(dir, script)], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected one design token block in extension\/lib\/theme\.css/);
    for (const [index, path] of targets.entries()) {
      assert.deepEqual(readFileSync(join(dir, path)), before[index], path);
    }
  });
});

test("the generator keeps whitespace inside a wrapped token value", () => {
  withTokenFixture((dir, script, targets) => {
    const source = join(dir, "tokens.css");
    const original = readFileSync(source, "utf8");
    const edited = original.replace("--shadow-pop:0 10px 30px", "--shadow-pop:0\n  10px 30px");
    assert.notEqual(edited, original);
    writeFileSync(source, edited);

    const result = spawnSync(process.execPath, [join(dir, script)], { encoding: "utf8" });
    assert.equal(result.status, 0);
    for (const path of targets) {
      const output = readFileSync(join(dir, path), "utf8");
      assert.match(output, /--shadow-pop:0\s+10px 30px/);
    }
  });
});

const read = (p) => readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const bytes = (p) => readFileSync(new URL("../../" + p, import.meta.url));
const styleOf = (html) => html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

const SHEETS = {
  dashboard: noComments(styleOf(read("docs/index.html"))),
  landing: noComments(
    (() => {
      const s = read("backend/internscout/site/assets.py");
      const a = s.indexOf('CSS = """') + 9;
      return s.slice(a, s.indexOf('"""', a));
    })(),
  ),
  employers: noComments(styleOf(read("docs/employers/index.html"))),
  // The buy page (2026-10-19) copies /employers/ whole, so its block is checked the same way.
  buy: noComments(styleOf(read("docs/employers/buy/index.html"))),
  extension: noComments(read("extension/lib/theme.css")),
};
const OVERLAY = noComments(
  (() => {
    const s = read("extension/agent/overlay.js");
    return s.slice(s.indexOf("<style>") + 7, s.indexOf("</style>"));
  })(),
);

// The declarations inside the first block that opens with `open` (e.g. ":root{" or
// "@media (prefers-color-scheme:dark){:root{"), as a Map of custom property to value.
function block(css, open) {
  const flat = css.replace(/\s*\n\s*/g, "");
  const at = open === ":root{" ? flat.search(/(^|\})\s*:root\{/) : flat.indexOf(open);
  assert.ok(at >= 0, `no ${open} block`);
  const start = flat.indexOf(open, at) + open.length;
  const body = flat.slice(start, flat.indexOf("}", start));
  const m = new Map();
  for (const d of body.split(";")) {
    const i = d.indexOf(":");
    if (i > 0 && d.trim().startsWith("--")) m.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
  }
  return m;
}
const LIGHT = ":root{",
  DARK = "@media (prefers-color-scheme:dark){:root{",
  COARSE = "@media (pointer:coarse){:root{";
const source = {
  light: block(SHEETS.dashboard, LIGHT),
  dark: block(SHEETS.dashboard, DARK),
  coarse: block(SHEETS.dashboard, COARSE),
};

const COLOURS = [
  "paper",
  "panel",
  "sunk",
  "ink",
  "ink2",
  "ink3",
  "rule",
  "rule2",
  "field-border",
  "accent",
  "accent-ink",
  "accent-hover",
  "accent-soft",
  "blue",
  "amber",
  "amber-soft",
  "green",
  "red",
].map((k) => "--" + k);

test("the dashboard's block has every token the spec names", () => {
  const want = [
    ...COLOURS,
    "--serif",
    "--sans",
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => "--fs-" + i),
    "--lh",
    "--lh-head",
    ...[1, 2, 3, 4, 5, 6, 7].map((i) => "--s" + i),
    "--r-sm",
    "--r",
    "--r-lg",
    "--r-pill",
    "--shadow-pop",
    "--ring",
    "--h-ctl",
    "--h-ctl-sm",
    "--h-field",
    ...["chevron", "search", "check", "cross", "alert", "external", "select"].map(
      (k) => "--i-" + k,
    ),
  ];
  for (const k of want) assert.ok(source.light.has(k), `${k} missing from docs/index.html`);
  for (const k of COLOURS) assert.ok(source.dark.has(k), `${k} missing from the dark block`);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 8].map((i) => source.light.get("--fs-" + i)),
    ["12px", "13px", "15px", "16px", "18px", "22px", "28px", "34px"],
  );
  assert.deepEqual(
    ["--r-sm", "--r", "--r-lg", "--r-pill"].map((k) => source.light.get(k)),
    ["4px", "6px", "8px", "999px"],
  );
  assert.match(
    source.light.get("--shadow-pop"),
    /color-mix\(in srgb,var\(--ink\)/,
    "the shadow is tinted from ink, so it shows in dark mode",
  );
  assert.equal(source.light.get("--h-field"), "40px");
  assert.equal(source.coarse.get("--h-ctl"), "44px");
  assert.equal(source.coarse.get("--h-field"), "44px");
  assert.ok(!source.light.has("--mono"), "no mono face any more");
});

for (const [name, css] of Object.entries(SHEETS).filter(([n]) => n !== "dashboard")) {
  test(`the ${name} copy of the tokens matches the dashboard's, light, dark and touch`, () => {
    assert.deepEqual(Object.fromEntries(block(css, LIGHT)), Object.fromEntries(source.light));
    assert.deepEqual(Object.fromEntries(block(css, DARK)), Object.fromEntries(source.dark));
    assert.deepEqual(Object.fromEntries(block(css, COARSE)), Object.fromEntries(source.coarse));
  });
}

test("the in-tab overlay card uses the same colours, light and dark", () => {
  const light = block(OVERLAY, ":host{"),
    dark = block(OVERLAY, "@media (prefers-color-scheme:dark){:host{");
  for (const k of COLOURS) {
    assert.equal(light.get(k), source.light.get(k), `overlay ${k}`);
    assert.equal(dark.get(k), source.dark.get(k), `overlay dark ${k}`);
  }
  for (const [k, v] of light)
    if (source.light.has(k)) assert.equal(v, source.light.get(k), `overlay ${k}`);
  // No colour typed in outside the token block (was: #9a6412, #1f7a4d and #868b92, all under AA).
  const rules = OVERLAY.replace(/:host\{[^}]*\}/g, "");
  assert.doesNotMatch(rules, /#[0-9a-f]{3,6}\b/i);
});

// WCAG relative luminance.
function lum(hex) {
  const h = hex.replace("#", "");
  const n = h.length === 3 ? h.split("").map((c) => c + c) : h.match(/../g);
  const [r, g, b] = n
    .map((x) => parseInt(x, 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

for (const scheme of ["light", "dark"]) {
  test(`colour pairs pass WCAG AA (${scheme})`, () => {
    const t = (k) => source[scheme].get("--" + k) || source.light.get("--" + k);
    const text = [
      ["ink", "paper"],
      ["ink2", "paper"],
      ["ink3", "paper"],
      ["ink3", "panel"],
      ["ink3", "sunk"],
      ["accent", "paper"],
      ["accent-ink", "accent"],
      ["accent-ink", "accent-hover"],
      ["accent", "accent-soft"],
      ["ink2", "accent-soft"],
      ["amber", "amber-soft"],
      ["green", "accent-soft"],
      ["red", "paper"],
      ["red", "panel"],
      ["red", "sunk"],
      ["blue", "paper"],
    ];
    for (const [f, b] of text)
      assert.ok(ratio(t(f), t(b)) >= 4.5, `${f} on ${b}: ${ratio(t(f), t(b)).toFixed(2)}:1`);
    // A control's edge needs 3:1 against what is next to it (WCAG 1.4.11).
    for (const b of ["paper", "panel"])
      assert.ok(
        ratio(t("field-border"), t(b)) >= 3,
        `field-border on ${b}: ${ratio(t("field-border"), t(b)).toFixed(2)}:1`,
      );
  });
}

test("the two faces are self-hosted, the same files for the site and the extension, with their licences", () => {
  for (const f of ["ibm-plex-sans-latin.woff2", "source-serif-4-latin.woff2"]) {
    const site = bytes("docs/fonts/" + f),
      ext = bytes("extension/lib/fonts/" + f);
    assert.equal(site.subarray(0, 4).toString("latin1"), "wOF2", `${f} is woff2`);
    assert.ok(site.equals(ext), `${f}: the extension's copy is the site's`);
  }
  for (const dir of ["docs/fonts/", "extension/lib/fonts/"]) {
    for (const f of ["OFL-IBM-Plex-Sans.txt", "OFL-Source-Serif-4.txt"]) {
      assert.ok(existsSync(new URL("../../" + dir + f, import.meta.url)), `${dir}${f}`);
      assert.match(read(dir + f), /SIL Open Font License, Version 1\.1/);
    }
  }
  const faces = {
    dashboard: "fonts/",
    landing: "/fonts/",
    employers: "/fonts/",
    buy: "/fonts/",
    extension: "fonts/",
  };
  for (const [name, base] of Object.entries(faces)) {
    const css = SHEETS[name];
    assert.ok(
      css.includes(
        `@font-face{font-family:"IBM Plex Sans";src:url(${base}ibm-plex-sans-latin.woff2) format("woff2")`,
      ),
      `${name} loads Plex Sans`,
    );
    assert.ok(
      css.includes(
        `@font-face{font-family:"Source Serif 4";src:url(${base}source-serif-4-latin.woff2) format("woff2")`,
      ),
      `${name} loads Source Serif 4`,
    );
    assert.ok(
      css.includes('@font-face{font-family:"Plex Fallback"'),
      `${name} has the measured fallback`,
    );
  }
  // Nothing fetched from Google any more, on the dashboard or the generated pages.
  assert.doesNotMatch(read("docs/index.html"), /fonts\.googleapis\.com|fonts\.gstatic\.com/);
  assert.doesNotMatch(read("backend/internscout/site/assets.py"), /fonts\.googleapis\.com/);
});

// Every font size in the four sheets and the extension pages is one of the eight steps, and nothing is
// under 12px (was: up to 16 sizes, down to 10.5px).
const PAGES = {
  ...SHEETS,
  onboarding: noComments(styleOf(read("extension/onboarding/onboarding.html"))),
  popup: noComments(styleOf(read("extension/popup/popup.html"))),
  sidepanel: noComments(styleOf(read("extension/sidepanel/sidepanel.html"))),
  overlay: OVERLAY,
};
test("type: only the eight sizes, none under 12px, and no mono face", () => {
  for (const [name, css] of Object.entries(PAGES)) {
    const raw = [
      ...css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g),
      ...css.matchAll(/font:\s*(?:(?:italic|normal|[1-9]00)\s+)*(\d+(?:\.\d+)?)px/g),
    ].map((m) => m[1]);
    assert.deepEqual(raw, [], `${name} has sizes outside the scale: ${raw.join(", ")}`);
    const steps = [...css.matchAll(/var\(--fs-(\d+)\)/g)].map((m) => +m[1]);
    assert.ok(steps.length > 0 && steps.every((n) => n >= 1 && n <= 8), name);
    assert.doesNotMatch(css, /var\(--mono\)|Plex Mono|Cascadia/, name);
  }
});

test("radii: only the four tokens, plus circles and the small focus corners", () => {
  for (const [name, css] of Object.entries(PAGES)) {
    for (const m of css.matchAll(/([^{}]*)\{[^}]*?border-radius:([^;}]+)/g)) {
      const [sel, v] = [m[1], m[2].trim()];
      if (/^var\(--r(-sm|-lg|-pill)?\)$/.test(v) || v === "50%" || v === "0") continue;
      assert.ok(/focus/.test(sel) && v === "2px", `${name}: ${sel.trim()} has border-radius:${v}`);
    }
  }
});

test("focus is visible on every control: no outline:none on a focused field in the extension", () => {
  for (const name of ["onboarding", "sidepanel", "popup", "extension"]) {
    assert.doesNotMatch(PAGES[name], /:focus\s*\{[^}]*outline:\s*none/, name);
  }
  for (const [name, css] of Object.entries(SHEETS))
    assert.match(
      css,
      /:focus-visible\{outline:2px solid var\(--accent\);outline-offset:2px\}/,
      name,
    );
  assert.match(OVERLAY, /:focus-visible\{outline:2px solid var\(--accent\);outline-offset:2px\}/);
});

test("disabled buttons read at 4.6:1 instead of fading to 45%", () => {
  for (const [name, css] of Object.entries(PAGES))
    assert.doesNotMatch(css, /opacity:\s*\.45/, name);
  assert.match(
    SHEETS.dashboard,
    /\.btn:disabled[^{]*\{color:var\(--ink3\);background:var\(--sunk\);border-color:var\(--field-border\)/,
  );
  assert.match(
    SHEETS.extension,
    /\.btn:disabled[^{]*\{color:var\(--ink3\);background:var\(--sunk\);border-color:var\(--field-border\)/,
  );
});

test("controls: buttons and fields take their height and edge from the tokens", () => {
  assert.match(
    SHEETS.dashboard,
    /\.btn\{[^}]*height:var\(--h-ctl\)[^}]*border:1px solid var\(--field-border\)/,
  );
  assert.match(SHEETS.dashboard, /\.btn\.small\{height:var\(--h-ctl-sm\)/);
  assert.match(SHEETS.dashboard, /\.field\{[^}]*min-height:var\(--h-field\)/);
  assert.match(SHEETS.extension, /\.btn\{[^}]*min-height:var\(--h-ctl\)/);
  assert.match(
    SHEETS.extension,
    /\.btn\.primary:hover:not\(:disabled\)\{background:var\(--accent-hover\)/,
  );
  assert.doesNotMatch(SHEETS.extension, /filter:\s*brightness/);
  // Every text field in the extension pages has the 3:1 edge (was --rule, 1.33:1).
  assert.doesNotMatch(PAGES.onboarding, /select,textarea\{[^}]*border:1px solid var\(--rule\)/);
  assert.doesNotMatch(PAGES.sidepanel, /textarea,input\{[^}]*border:1px solid var\(--rule\)/);
  // Side panel buttons are theme.css .btn.small, 32px (was its own button.b, about 26px; D25 removed it).
  assert.match(SHEETS.extension, /\.btn\.small\{min-height:var\(--h-ctl-sm\)/);
  assert.doesNotMatch(PAGES.sidepanel, /button\.b\{/, "side panel buttons 32px, was about 26px");
});

test("one icon set of six, shared by the site and the extension", () => {
  for (const [name, css] of Object.entries(SHEETS)) {
    assert.match(
      css,
      /\.i\{display:inline-block;width:1em;height:1em;[^}]*mask:var\(--i\) center\/contain no-repeat\}/,
      name,
    );
    for (const k of ["chevron", "search", "check", "cross", "alert", "external"])
      assert.ok(css.includes(`.i-${k}{--i:var(--i-${k})}`), `${name} .i-${k}`);
  }
  // The dashboard's chevrons and search glass are the icons, not borders and box-shadows.
  assert.match(
    SHEETS.dashboard,
    /\.field\.sel::after,\.field\.ms::after\{[^}]*mask:var\(--i-chevron\)/,
  );
  assert.match(SHEETS.dashboard, /\.field\.search::before\{[^}]*mask:var\(--i-search\)/);
  assert.match(SHEETS.dashboard, /select\.mine\{[^}]*var\(--i-select\)[^}]*appearance:none/);
  // The Why panel's ✓ ✗ ! characters are icons with the meaning in words for a screen reader.
  const app = read("docs/js/app.js").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(app, /"✓ "|"✗ "|"! "/);
  assert.match(app, /icon\("check", "Have: "\)/);
});

test("status chips carry an icon, so the state never rests on colour alone", () => {
  assert.match(SHEETS.dashboard, /\.st\.needs_you::before\{--i:var\(--i-alert\)\}/);
  assert.match(
    SHEETS.dashboard,
    /\.st\.ready_to_submit::before,\.st\.submitted::before\{--i:var\(--i-check\)\}/,
  );
  assert.match(SHEETS.dashboard, /\.st\.failed::before\{--i:var\(--i-cross\)\}/);
  assert.match(PAGES.sidepanel, /\.needs_you \.st::before\{--i:var\(--i-alert\)\}/);
  assert.match(SHEETS.dashboard, /\.st\{[^}]*font:500 var\(--fs-1\)/);
});

test("one notice style: accent-soft fill at 15px", () => {
  assert.match(
    SHEETS.dashboard,
    /\.notice\{[^}]*background:var\(--accent-soft\)[^}]*font-size:var\(--fs-3\)/,
  );
  assert.doesNotMatch(SHEETS.dashboard, /\.notice\.quietnote\{/);
  assert.match(
    SHEETS.extension,
    /\.notice\{[^}]*background:var\(--accent-soft\)[^}]*font-size:var\(--fs-3\)/,
  );
});
