import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createFollowForm, followSelection } from "../../docs/js/follow-form.mjs";
const company = { kind: "company", company: { key: "example", label: "Example Robotics" } };
const search = {
  kind: "search",
  fields: [{ key: "engineering", label: "Engineering" }],
  states: [],
};
const h = (type, props, ...children) => ({
  type,
  props: props || {},
  children: children.flat().filter((v) => v !== false && v != null),
});
const all = (n, type) =>
  typeof n === "object" && n
    ? [...(n.type === type ? [n] : []), ...n.children.flatMap((c) => all(c, type))]
    : [];
const words = (n) =>
  typeof n === "object" && n ? n.children.map(words).join(" ") : String(n ?? "");
function fixture(extra = {}) {
  let props = { enabled: true, selection: company, ...extra },
    state = [],
    cursor,
    effects = [],
    currentKey,
    tree,
    cleanup = [];
  const hooks = {
    h,
    useId: () => "follow-test",
    useRef: (value) => {
      const i = cursor++;
      return (state[i] ??= { current: value });
    },
    useState: (initial) => {
      const i = cursor++;
      if (!(i in state)) state[i] = initial;
      return [
        state[i],
        (v) => {
          state[i] = v;
        },
      ];
    },
    useEffect: (fn, deps) => {
      const i = cursor++;
      if (!state[i] || deps.some((v, j) => v !== state[i][j])) {
        effects.push(() => {
          cleanup[i]?.();
          cleanup[i] = fn();
        });
        state[i] = deps;
      }
    },
  };
  const Component = createFollowForm(hooks);
  const render = () => {
    const outer = Component(props);
    if (!outer || outer.props.key !== currentKey) {
      cleanup.forEach((fn) => fn?.());
      cleanup = [];
      state = [];
      currentKey = outer?.props.key;
    }
    cursor = 0;
    effects = [];
    tree = outer ? outer.type(outer.props) : null;
    effects.forEach((fn) => fn());
    return tree;
  };
  const open = () => {
    all(tree, "button")[0].props.onClick();
    render();
  };
  const email = (value) => {
    all(tree, "input")[0].props.onChange({ target: { value } });
    render();
  };
  const submit = () => all(tree, "form")[0].props.onSubmit({ preventDefault() {} });
  render();
  return {
    render,
    open,
    email,
    submit,
    get tree() {
      return tree;
    },
    update(p) {
      props = { ...props, ...p };
      return render();
    },
  };
}
test("default and nonliteral enablement render nothing; form has no network/storage port", () => {
  for (const enabled of [undefined, false, "true", 1, null])
    assert.equal(fixture({ enabled }).tree, null);
  assert.doesNotMatch(
    readFileSync("docs/js/app/follow-form.mjs", "utf8"),
    /\bfetch\s*\(|localStorage|sessionStorage/,
  );
});
test("selection uses exact company and search copy, only scope keys, and explicit empty-dimension labels", () => {
  assert.deepEqual(followSelection(company).scope, { kind: "company", company: "example" });
  assert.equal(
    followSelection(company).title,
    "Email me when Example Robotics posts an internship",
  );
  assert.equal(
    followSelection(search).summary,
    "Following: Engineering; Anywhere. Other search filters are not included.",
  );
  assert.equal(
    followSelection({ kind: "search", fields: [], states: [{ key: "MA", label: "Massachusetts" }] })
      .summary,
    "Following: All fields; Massachusetts. Other search filters are not included.",
  );
  for (const selection of [
    null,
    { kind: "search", fields: [], states: [] },
    { kind: "search", fields: [,], states: [] },
    { kind: "company", company: { key: {}, label: "X" } },
  ])
    assert.equal(followSelection(selection), null);
});
test("invalid input never invokes callback and signed-out has no linkage control", async () => {
  let calls = 0;
  const f = fixture({ request: () => calls++ });
  f.open();
  assert.equal(all(f.tree, "input").length, 1);
  for (const value of ["", "bad@", "<a>@example.test", "a\n@example.test"]) {
    f.email(value);
    await f.submit();
    f.render();
    assert.match(words(f.tree), /Enter a valid email address\./);
  }
  assert.equal(calls, 0);
  const invalid = fixture({ selection: { kind: "search", fields: [], states: [] } });
  invalid.open();
  assert.match(words(invalid.tree), /Choose a company or at least one field or state\./);
  assert.equal(all(invalid.tree, "button").at(-1).props.disabled, true);
});
test("one callback, explicit unchecked consent and generic accepted response; scope copy cannot be mutated", async () => {
  let release,
    payload,
    signal,
    calls = 0;
  const f = fixture({
    signedIn: true,
    selection: search,
    request: (p, options) => {
      payload = p;
      signal = options.signal;
      calls++;
      return new Promise((r) => (release = r));
    },
  });
  f.open();
  assert.equal(all(f.tree, "input")[1].props.checked, false);
  all(f.tree, "input")[1].props.onChange({ target: { checked: true } });
  f.render();
  f.email(" Example@EXAMPLE.TEST ");
  const pending = f.submit();
  await f.submit();
  f.render();
  assert.equal(calls, 1);
  assert.equal(all(f.tree, "form")[0].props["aria-busy"], true);
  all(f.tree, "button")[0].props.onClick();
  f.render();
  assert.equal(all(f.tree, "form").length, 1);
  assert.equal(all(f.tree, "input")[1].props.checked, true);
  assert.deepEqual(payload, {
    email: "example@example.test",
    link: true,
    scope: { kind: "search", fields: ["engineering"], states: [] },
  });
  payload.scope.fields.push("other");
  assert.equal(search.fields.length, 1);
  assert.equal(signal.aborted, false);
  release({ status: "accepted", subscriber: "ignored-private-reply" });
  await pending;
  f.render();
  assert.match(
    words(f.tree),
    /If this address can receive email, a confirmation link is on its way\./,
  );
  assert.doesNotMatch(words(f.tree), /ignored-private/);
  assert.equal(all(f.tree, "input")[0].props.value, "");
  assert.equal(all(f.tree, "input")[1].props.checked, false);
});
test("errors and malformed outcomes stay generic and allow a later retry", async () => {
  let calls = 0;
  const f = fixture({
    request: async () => {
      if (++calls === 1) throw Error("private-provider-detail");
      return { status: "unknown" };
    },
  });
  f.open();
  f.email("test@example.test");
  for (let i = 0; i < 2; i++) {
    await f.submit();
    f.render();
    assert.match(words(f.tree), /Email follows are unavailable\. Please try again later\./);
    assert.doesNotMatch(words(f.tree), /private-provider/);
  }
  assert.equal(calls, 2);
});
test("scope, account generation and disabling abort pending UI and reset consent without stale feedback", async () => {
  for (const update of [
    { selection: search },
    { sessionGeneration: 1 },
    { signedIn: false },
    { enabled: false },
  ]) {
    let release, signal;
    const f = fixture({
      signedIn: true,
      request: (_, options) => {
        signal = options.signal;
        return new Promise((r) => (release = r));
      },
    });
    f.open();
    all(f.tree, "input")[1].props.onChange({ target: { checked: true } });
    f.render();
    f.email("test@example.test");
    const pending = f.submit();
    f.update(update);
    assert.equal(signal.aborted, true);
    release({ status: "accepted" });
    await pending;
    f.render();
    assert.doesNotMatch(words(f.tree), /confirmation link is on its way/);
    if (f.tree) {
      f.open();
      const checkbox = all(f.tree, "input").find((v) => v.props.type === "checkbox");
      if (checkbox) assert.equal(checkbox.props.checked, false);
    }
  }
});

test("dismiss and reopen clears email, explicit linkage and every feedback state", async () => {
  for (const outcome of ["invalid", "accepted", "unavailable", "typed"]) {
    const f = fixture({ signedIn: true, request: async () => ({ status: outcome }) });
    f.open();
    f.email(outcome === "invalid" ? "invalid@" : "synthetic@example.test");
    all(f.tree, "input")[1].props.onChange({ target: { checked: true } });
    f.render();
    if (outcome !== "typed") {
      await f.submit();
      f.render();
    }
    all(f.tree, "button")[0].props.onClick();
    f.render();
    assert.equal(all(f.tree, "form").length, 0);
    f.open();
    const inputs = all(f.tree, "input");
    assert.equal(inputs[0].props.value, "");
    assert.equal(inputs[0].props["aria-invalid"], false);
    assert.equal(inputs[1].props.checked, false);
    assert.equal(words(all(f.tree, "p").find((v) => v.props.role === "status")), "");
  }
});
