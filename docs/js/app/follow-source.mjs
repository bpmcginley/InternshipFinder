// Preserve only Follow ambiguity bits when the existing dashboard normalizes its URL.
const MARKER = "internscoutFollowAmbiguity";
const stable = (values) =>
  Array.isArray(values) &&
  values.length <= 128 &&
  Array.from(values).every((value) => typeof value === "string")
    ? JSON.stringify([...new Set(values)].sort())
    : null;

export function createFollowSource(browser) {
  const enabled =
    browser.document?.documentElement?.getAttribute?.("data-follow-signup-enabled") === "1";
  let flags = { fields: false, states: false },
    expected = {},
    revision = 0;
  function persist() {
    const state = browser.history.state;
    if (
      state !== null &&
      (typeof state !== "object" ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(state)))
    )
      return false;
    const next = { ...state };
    if (flags.fields || flags.states) next[MARKER] = { ...flags };
    else delete next[MARKER];
    try {
      browser.history.replaceState(next, "", browser.location.href);
      return true;
    } catch {
      return false;
    }
  }
  function read() {
    const query = new browser.URLSearchParams(browser.location.search);
    const prior = browser.history.state?.[MARKER];
    const validPrior =
      prior &&
      typeof prior === "object" &&
      !Array.isArray(prior) &&
      Object.keys(prior).sort().join(",") === "fields,states" &&
      typeof prior.fields === "boolean" &&
      typeof prior.states === "boolean";
    for (const [dimension, name, max, pattern] of [
      ["fields", "field", 128, /^[a-z_]{2,32}$/],
      ["states", "state", 80, /^(?:[A-Z]{2}|all)$/],
    ]) {
      const raw = query.getAll(name);
      const values = raw.length === 1 && raw[0].length <= 8192 ? raw[0].split(",") : [];
      const invalid =
        raw.length > 0 &&
        (raw.length !== 1 ||
          raw[0].length > 8192 ||
          !values.length ||
          values.length > max ||
          values.some((value) => !pattern.test(value)));
      flags[dimension] = invalid || (prior !== undefined && (!validPrior || prior[dimension]));
      expected[dimension] = invalid ? null : stable(values);
    }
    if (flags.fields || flags.states || prior !== undefined) persist();
  }
  if (enabled) read();
  return {
    enabled,
    get revision() {
      return revision;
    },
    allowed(filters) {
      return (
        !enabled ||
        (!flags.fields &&
          !flags.states &&
          expected.fields !== null &&
          expected.states !== null &&
          expected.fields === stable(filters.fields) &&
          expected.states === stable(filters.states))
      );
    },
    canNormalize() {
      // OAuth callbacks clear history state before their first await. Re-establish the bits
      // immediately before the dashboard can erase the raw evidence.
      return !enabled || (!flags.fields && !flags.states) || persist();
    },
    correct(dimension, values) {
      if (!enabled || !["fields", "states"].includes(dimension)) return;
      flags[dimension] = false;
      expected[dimension] = stable(values);
      revision++;
      persist();
    },
    navigate() {
      if (!enabled) return;
      revision++;
      read();
    },
  };
}
