import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";
import { callAI, jsonOf, textOf } from "../background/claude.js";
import { modelFor } from "../lib/store.js";
import { interviewSystem } from "../onboarding/interview-prompt.js";
import { applyInterviewFacts } from "../onboarding/profile.js";

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
  const store = {
    [key]: previous,
    "internscout.session": { token: "iss_synthetic_session", expires: "2099-01-01T00:00:00Z" },
  };
  const delayed = Promise.withResolvers(),
    writing = Promise.withResolvers();
  const profileWriting = Promise.withResolvers(),
    profileDelayed = Promise.withResolvers();
  const late = "Late reply from the previous conversation.";
  const chrome = {
    storage: {
      local: {
        get: async (name) => ({ [name]: structuredClone(store[name]) }),
        async set(patch) {
          const data = structuredClone(patch);
          if (data[key]?.at(-1)?.content === late) {
            writing.resolve();
            await delayed.promise;
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
  const S = {
    ai: { provider: "internscout" },
    settings: { deep_dive_run: runId },
    profile: { facts: {}, stories: [], goals: {} },
  };
  let savedProfile;
  const context = vm.createContext({
    S,
    chrome,
    AbortController,
    callAI,
    jsonOf,
    textOf,
    applyInterviewFacts,
    modelFor,
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
    async save() {
      if (S.profile.stories.length && !savedProfile) {
        profileWriting.resolve();
        await profileDelayed.promise;
        savedProfile = structuredClone(S.profile);
      }
    },
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

  const finishing = node("finish").click();
  await until(() => requests.length === 2);
  assert.equal(node("restart").disabled, false);
  requests[1].finish(JSON.stringify({ stories: [{ theme: "Synthetic project" }] }));
  await profileWriting.promise;
  assert.equal(node("restart").disabled, true);
  await node("restart").click();
  assert.equal(savedProfile, undefined);
  assert.equal(store[key].at(-1).content, "The current interview received the original reply.");
  assert.equal(requests.length, 2);
  profileDelayed.resolve();
  await finishing;
  assert.equal(savedProfile.stories[0].theme, "Synthetic project");
  assert.equal(node("restart").disabled, false);

  submit();
  await until(() => requests.length === 3);
  requests[2].finish(late);
  await writing.promise;
  const restarting = node("restart").click();
  delayed.resolve();
  await restarting;
  await until(() => requests.length === 4);
  requests[3].finish("Welcome to the new conversation.");
  await until(() => node("chat").innerHTML.includes("Welcome to the new conversation."));
  assert.equal(node("chat").innerHTML.includes(late), false);
  assert.equal(store[key].length, 2);
  assert.equal(store[key].at(-1).content, "Welcome to the new conversation.");
});
