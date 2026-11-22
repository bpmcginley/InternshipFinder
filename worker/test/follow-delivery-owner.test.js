import test from "node:test";
import { fakeD1 } from "./helpers.js";
import * as scenarios from "../test-support/follow-delivery-owner.js";
function database() {
  const db = fakeD1();
  const wrap = (s) => ({
    ...s,
    bind: (...args) => wrap(s.bind(...args)),
    all: async () => {
      const r = await s.all();
      return { ...r, meta: { ...r.meta, changes: 0 } };
    },
  });
  return { ...db, prepare: (sql) => wrap(db.prepare(sql)) };
}
for (const [name, scenario] of Object.entries(scenarios))
  test(`Follow delivery owner: ${name}`, () => scenario(database()));
