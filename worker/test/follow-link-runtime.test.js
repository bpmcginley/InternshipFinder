import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-link-runtime.js";
function database() {
  const db = fakeD1();
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
  test(`Follow link runtime: ${name}`, () => scenario(database()));
