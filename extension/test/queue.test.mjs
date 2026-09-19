// The queue is rewritten whole on every update, so nothing heavy may live on a job.
import test from "node:test";
import assert from "node:assert/strict";

const data = {};
let refuse = null;          // a key prefix whose set() fails, to play a full disk
globalThis.chrome = { storage: { local: {
  async get(k) { return typeof k === "string" ? { [k]: data[k] } : Object.fromEntries([].concat(k).map((x) => [x, data[x]])); },
  async set(o) {
    for (const [k, v] of Object.entries(o)) {
      if (refuse && k.startsWith(refuse)) throw new Error("QUOTA_BYTES quota exceeded");
      data[k] = JSON.parse(JSON.stringify(v));
    }
  },
  async remove(k) { for (const x of [].concat(k)) delete data[x]; },
} } };

const { addJobs, updateJob, appendLog, getJob, getTailoredFile, removeJob, getQueue, publicQueue } = await import("../background/queue.js");
const BYTES = "A".repeat(600_000);
const file = () => ({ name: "Resume - Acme.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 450_000, b64: BYTES });

test("a tailored file's bytes are stored beside the queue, not in it", async () => {
  const { added: [id] } = await addJobs([{ id: 1, company: "Acme", title: "Intern", apply_url: "https://acme.example/jobs/1" }]);
  const job = await updateJob(id, { tailored: { status: "approved", diff: [], note: "kept your layout", file: file() } });
  assert.equal(job.tailored.file.b64, undefined);
  assert.equal(job.tailored.file.name, "Resume - Acme.docx");
  assert.ok(JSON.stringify(data.queue).length < 5000, "the queue itself stays small");
  assert.equal(data["tailored_" + id], BYTES);

  await appendLog(id, { kind: "note", text: "a log line" });     // the hot path: must not carry the bytes
  assert.ok(JSON.stringify(data.queue).length < 5000);

  const f = await getTailoredFile(id);
  assert.equal(f.b64, BYTES);
  assert.equal(f.type, file().type);
  assert.equal((await getJob(id)).tailored.note, "kept your layout");
  assert.ok(!JSON.stringify(publicQueue(await getQueue())).includes(BYTES.slice(0, 100)), "nothing heavy goes to the dashboard");

  await removeJob(id);
  assert.equal(data["tailored_" + id], undefined, "removing a job removes its resume bytes");
  assert.equal(await getTailoredFile(id), null);
});

test("a queue saved by an older version still works and is migrated on its next write", async () => {
  data.queue = { order: ["old1"], jobs: { old1: { id: "old1", status: "needs_you", log: [], tailored: { status: "pending", file: file() } } } };
  assert.equal((await getTailoredFile("old1")).b64, BYTES);
  await appendLog("old1", { kind: "note", text: "x" });
  assert.equal(data.queue.jobs.old1.tailored.file.b64, undefined);
  assert.equal(data.tailored_old1, BYTES);
  assert.equal((await getTailoredFile("old1")).b64, BYTES);
  await removeJob("old1");
});

test("when storage refuses the file the job survives and falls back to the original resume", async () => {
  const { added: [id] } = await addJobs([{ id: 2, company: "Beta", title: "Intern", apply_url: "https://beta.example/jobs/2" }]);
  refuse = "tailored_";
  const job = await updateJob(id, { tailored: { status: "approved", file: file() } });
  refuse = null;
  assert.equal(job.tailored.status, "failed");
  assert.ok((await getJob(id)), "the job is still queued");
  assert.equal(await getTailoredFile(id), null);
});
