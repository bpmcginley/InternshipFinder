// Opt-in parity against an exact local Worker checkout. Reads synthetic JSON on stdin.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const matcherPath = process.argv[2];
if (!matcherPath) throw new Error("Supply the local follow-matching.js path");
const { followSnapshotDigest, matchFollowSnapshot } = await import(
  pathToFileURL(resolve(matcherPath)).href
);
const input = JSON.parse(readFileSync(0, "utf8"));
const snapshot = new Uint8Array(Buffer.from(input.snapshot, "base64"));
const catalog = Object.fromEntries(
  Object.entries(input.catalog).map(([name, keys]) => [name, new Set(keys)]),
);
const match = matchFollowSnapshot(snapshot, input.scopes, {
  catalog,
  limits: input.limits,
  upperBound: input.upperBound,
});
process.stdout.write(JSON.stringify({ digest: await followSnapshotDigest(snapshot), match }));
