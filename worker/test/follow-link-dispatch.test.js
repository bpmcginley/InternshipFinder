import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-link-dispatch.js";
function database() {
  const db = fakeD1();
  // The shared fake omits SELECT.all changes; local D1 explicitly reports zero.
  const wrap = (statement) => ({
    ...statement,
    bind: (...args) => wrap(statement.bind(...args)),
    all: async () => {
      const result = await statement.all();
      return { ...result, meta: { ...result.meta, changes: 0 } };
    },
  });
  return { ...db, prepare: (sql) => wrap(db.prepare(sql)) };
}
for (const [name, scenario] of Object.entries(scenarios))
  if (!["seed", "config"].includes(name))
    test(`link dispatch: ${name}`, () => scenario(database()));
