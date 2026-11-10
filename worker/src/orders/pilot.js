import { conflict, text } from "./shared.js";

export const PILOT_MAX = 5;          // pilot codes, ever
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

// POST /admin/pilot-codes { note? }: a new pilot code, while fewer than PILOT_MAX have ever been made.
// The count and the insert are one statement, so two at once can't make a sixth.
export async function createPilotCode(db, body, now) {
  const note = text(body, "note");
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = "PILOT-" + [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
  const r = await db.prepare(
    "INSERT INTO pilot_codes (code, created, note) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM pilot_codes) < ?",
  ).bind(code, now.toISOString(), note, PILOT_MAX).run();
  if (!r.meta.changes) throw conflict("conflict", `All ${PILOT_MAX} pilot codes have been made`);
  const made = await db.prepare("SELECT COUNT(*) AS n FROM pilot_codes").first("n");
  return { code, note, created: now.toISOString(), made: Number(made), max: PILOT_MAX };
}
