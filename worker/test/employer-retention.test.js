import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/employer-retention.js";
function counterDb() {
  const db = fakeD1();
  return {
    ...db,
    prepare(sql) {
      const wrap = (statement) => ({
        ...statement,
        bind: (...args) => wrap(statement.bind(...args)),
        run: () => (/^\s*SELECT\b/i.test(sql) ? statement.all() : statement.run()),
      });
      return wrap(db.prepare(sql));
    },
  };
}
for (const [name, scenario] of Object.entries(scenarios).sort(([a], [b]) => a.localeCompare(b))) {
  if (name !== "measureRetentionReads")
    test(`employer retention: ${name}`, () => scenario(counterDb()));
}
