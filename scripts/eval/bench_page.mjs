// Headless Chrome for the offline benchmark: the rendered form is served at the posting's real apply
// URL (so location.href and the page context are what production sees), every other request is
// refused, and the extension's own page scripts (agent/guard.js, actions.js, dom.js) are injected the
// way agent.js inject() does. Nothing leaves the machine and nothing is ever submitted: the form has
// no action to post to, and guard.js blocks its submit button the same as on a live page.
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const ROOT = new URL("../../", import.meta.url);
const PAGE_FILES = ["agent/guard.js", "agent/actions.js", "agent/dom.js"].map((f) => readFileSync(new URL(`extension/${f}`, ROOT), "utf8"));
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

export async function openBrowser() {
  // A throwaway profile: never the student's or anyone's real Chrome profile.
  const dir = mkdtempSync(join(tmpdir(), "isbench-"));
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, userDataDir: dir,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking"] });
  const close = async () => { await browser.close().catch(() => {}); try { rmSync(dir, { recursive: true, force: true }); } catch (e) {} };
  return { browser, close };
}

// A fresh tab with the form loaded at `url`, the page scripts in, and fastFill already run with the
// profile's facts and résumé file (agent.js loop does this before every snapshot). Returns the tab and
// what fastFill filled.
export async function loadForm(browser, url, html, facts, resume) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (req.url() === url && req.resourceType() === "document") req.respond({ status: 200, contentType: "text/html; charset=utf-8", body: html });
    else req.abort("blockedbyclient");
  });
  await page.goto(url, { waitUntil: "load" });
  await inject(page);
  const pre = await page.evaluate((f, file) => window.ISDom.fastFill(f, file), facts, resume);
  return { page, pre: pre || [] };
}

export async function inject(page) {
  for (const src of PAGE_FILES) await page.addScriptTag({ content: src });
}

// One frame's snapshot, shaped like agent.js builds `frames` ({frameId, ...ISDom.snapshot()}).
export async function snapshotFrames(page) {
  await inject(page);   // idempotent: each file returns early when its version is already loaded
  const snap = await page.evaluate(() => window.ISDom.snapshot());
  return [{ frameId: 0, ...snap }];
}

export const act = (page, localRef, action, payload) => page.evaluate((r, a, p) => window.ISDom.act(r, a, p), localRef, action, payload);
