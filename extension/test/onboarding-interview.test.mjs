import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";
import { callAI, jsonOf, textOf } from "../background/claude.js";
import { emptyStore, modelFor, updateStore } from "../lib/store.js";
import { interviewSystem } from "../onboarding/interview-prompt.js";
import {
  applyInterviewFacts,
  confirmProfileValue,
  mergeProfileEdits,
} from "../onboarding/profile.js";

const source = readFileSync(new URL("../onboarding/onboarding.js", import.meta.url), "utf8");
const key = "deepdive_chat";
const runId = "00000000-0000-4000-8000-000000000001";

function between(start, end) {
  const first = source.indexOf(start),
    last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, "Onboarding fixture anchors");
  return source.slice(first, last);
}

async function until(condition) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await setTimeout(10);
  assert.ok(condition(), "Synthetic interview did not reach the expected state");
}

test("Interview owns the pending reply and fences conflicting conversation writes", async (t) => {
  const previous = [
    { role: "user", content: "(Begin the interview.)" },
    { role: "assistant", content: "Which synthetic project taught you the most?" },
  ];
  const S = emptyStore();
  S.settings.deep_dive_run = runId;
  S.profile.facts.first_name = "Initial fact";
  confirmProfileValue(S.profile, "facts", "first_name");
  const store = {
    [key]: previous,
    store: structuredClone(S),
    "internscout.session": { token: "iss_synthetic_session", expires: "2099-01-01T00:00:00Z" },
  };
  const delayed = Promise.withResolvers(),
    writing = Promise.withResolvers();
  let heldProfile;
  const holdProfile = (theme) => {
    const writing = Promise.withResolvers(),
      settle = Promise.withResolvers();
    return (heldProfile = { theme, writing, settle });
  };
  const late = "Late reply from the previous conversation.";
  const chrome = {
    storage: {
      local: {
        get: async (keys) =>
          Object.fromEntries([keys].flat().map((key) => [key, structuredClone(store[key])])),
        async set(patch) {
          const data = structuredClone(patch);
          if (data[key]?.at(-1)?.content === late) {
            writing.resolve();
            await delayed.promise;
          }
          if (heldProfile && data.store?.profile.stories[0]?.theme === heldProfile.theme) {
            const { writing, settle } = heldProfile;
            heldProfile = null;
            writing.resolve();
            await settle.promise;
          }
          Object.assign(store, data);
        },
      },
      session: { get: async () => ({}) },
    },
  };
  const originalChrome = globalThis.chrome;
  globalThis.chrome = chrome;
  t.after(() => {
    globalThis.chrome = originalChrome;
  });
  const requests = [];
  t.mock.method(globalThis, "fetch", (url, init) => {
    assert.match(String(url), /\/ai\?stream=1$/);
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.equal(body.task, "deep_dive");
    assert.equal(body.run_id, runId);
    return new Promise((resolve) => {
      requests.push({
        body,
        finish(text) {
          resolve(
            Response.json({
              candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
            }),
          );
        },
      });
    });
  });

  const nodes = new Map();
  const node = (id) => nodes.get("#" + id);
  const main = {
    set innerHTML(markup) {
      nodes.clear();
      for (const [, id] of markup.matchAll(/\bid="([^"]+)"/g)) {
        nodes.set("#" + id, {
          value: "",
          innerHTML: "",
          scrollHeight: 0,
          addEventListener(type, handler) {
            this[type] = handler;
          },
          focus() {},
        });
      }
    },
    querySelector: (selector) => nodes.get(selector),
    insertAdjacentHTML() {},
  };
  const noop = () => {};
  const context = vm.createContext({
    S,
    chrome,
    AbortController,
    structuredClone,
    callAI,
    jsonOf,
    textOf,
    applyInterviewFacts,
    mergeProfileEdits,
    modelFor,
    updateStore,
    BACKGROUND_SETTINGS: [],
    saveChain: Promise.resolve(),
    savedSnapshot: structuredClone(S),
    interviewSystem,
    main,
    step: "interview",
    renderEpoch: 0,
    quickWasReady: null,
    restoredNote: "",
    interviewChat: null,
    interviewWrites: Promise.resolve(),
    seenRestore: null,
    restoredAt: async () => null,
    confirm: () => true,
    $: (selector) => main.querySelector(selector),
    esc: String,
    busy: noop,
    clearTimeout: noop,
    setTimeout: noop,
    drawSteps: noop,
    wireNav: noop,
    focusStepHeading: noop,
    setup: noop,
    files: noop,
    facts: noop,
    review: noop,
    navButtons: () => "",
    voice: () => {
      main.innerHTML = "<h2>Voice</h2>";
    },
    scrollTo: noop,
  });
  vm.runInContext(
    between("let saveTimer = null;", "window.addEventListener") +
      between("const runId = () =>", "const busy =") +
      between("function go(id)", "function navButtons") +
      between("function render()", "// The background restored") +
      between('const CHAT_KEY = "deepdive_chat";', "// ---------- 5. voice") +
      "\nglobalThis.openInterview = () => interview(++renderEpoch); globalThis.navigate = go;",
    context,
  );
  const type = (value) => {
    node("say").value = value;
    node("say").input();
  };
  const submit = () => node("say").keydown({ key: "Enter", ctrlKey: true, preventDefault: noop });
  await context.openInterview();
  type("I built a synthetic sorting demo for class.");
  submit();
  await until(() => requests.length === 1);
  type("My draft for the next question.");
  submit();
  context.navigate("voice");
  context.navigate("interview");
  await until(() => !!node("say"));
  assert.equal(node("say").value, "My draft for the next question.");
  assert.equal(node("send").disabled, true);
  requests[0].finish("The current interview received the original reply.");
  await until(() =>
    node("chat").innerHTML.includes("The current interview received the original reply."),
  );
  assert.equal(store[key].at(-1).content, "The current interview received the original reply.");
  assert.equal(requests.length, 1);

  const accepted = holdProfile("Synthetic project");
  const finishing = node("finish").click();
  await until(() => requests.length === 2);
  assert.equal(node("restart").disabled, false);
  requests[1].finish(
    JSON.stringify({
      stories: [{ theme: "Synthetic project" }],
      goals: { career: "Proposed goal" },
      facts: { first_name: "Proposed fact" },
    }),
  );
  await accepted.writing.promise;
  assert.equal(node("restart").disabled, true);
  await node("restart").click();
  assert.equal(S.profile.stories.length, 0);
  assert.equal(store.store.profile.stories.length, 0);
  assert.equal(store[key].at(-1).content, "The current interview received the original reply.");
  assert.equal(requests.length, 2);
  S.profile.voice.sample = "Unrelated edit while the accepted write is held.";
  S.profile.goals.career = "Manual goal";
  S.profile.facts.first_name = "Manual fact";
  confirmProfileValue(S.profile, "facts", "first_name");
  context.navigate("voice");
  context.navigate("interview");
  accepted.settle.resolve();
  await finishing;
  await until(() => store.store.profile.voice.sample === S.profile.voice.sample);
  assert.equal(store.store.profile.stories[0].theme, "Synthetic project");
  assert.equal(node("restart").disabled, false);

  const rejected = holdProfile("Rejected project");
  const failing = node("finish").click();
  await until(() => requests.length === 3);
  requests[2].finish(
    JSON.stringify({
      stories: [{ theme: "Rejected project" }],
      goals: { career: "Rejected goal" },
      facts: { first_name: "Rejected fact" },
    }),
  );
  await rejected.writing.promise;
  S.profile.voice.sample = "Unrelated edit while the rejected write is held.";
  context.navigate("voice");
  context.navigate("interview");
  rejected.settle.reject(new Error("Synthetic profile write rejected."));
  await failing;
  assert.match(node("cstat").innerHTML, /Synthetic profile write rejected/);
  await until(() => store.store.profile.voice.sample === S.profile.voice.sample);

  submit();
  await until(() => requests.length === 4);
  requests[3].finish(late);
  await writing.promise;
  const restarting = node("restart").click();
  delayed.resolve();
  await restarting;
  await until(() => requests.length === 5);
  requests[4].finish("Welcome to the new conversation.");
  await until(() => node("chat").innerHTML.includes("Welcome to the new conversation."));
  assert.equal(node("chat").innerHTML.includes(late), false);
  assert.equal(store[key].length, 2);
  assert.equal(store[key].at(-1).content, "Welcome to the new conversation.");
  for (const profile of [S.profile, store.store.profile]) {
    assert.equal(profile.stories[0].theme, "Synthetic project");
    assert.equal(profile.goals.career, "Manual goal");
    assert.equal(profile.facts.first_name, "Manual fact");
    assert.deepEqual(profile.sources.facts.first_name, { source: "manual", value: "Manual fact" });
    assert.equal(profile.voice.sample, "Unrelated edit while the rejected write is held.");
  }
});
