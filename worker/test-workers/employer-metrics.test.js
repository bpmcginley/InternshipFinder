// 2026-10-23: actual local D1 must count committed payment transitions once, never failed batches.
import { env } from "cloudflare:workers";
import { beforeAll, expect, it } from "vitest";

beforeAll(async () => {
  await env.DB.batch(env.TEST_SCHEMA_SQL.map(s => env.DB.prepare(s)));
});

it("D1 commits employer funnel marks and totals together and rejects transition replay", async () => {
  const id="o-aaaaaaaaaaaaaaa1", at="2026-10-22T12:00:00Z";
  await env.DB.prepare("INSERT INTO employer_orders (id,created,updated,status,package,start_day,employer_key,employer,company,name,email,email_domain,terms_version,terms_at,price) " +
    "VALUES (?,?,?,'unverified','one','2026-11-01','runtime','Runtime','Runtime','Synthetic','test@example.invalid','example.invalid','2026-10-19',?,2900)").bind(id,at,at,at).run();
  await expect(env.DB.batch([
    env.DB.prepare("UPDATE employer_orders SET status='verified',verified_at=? WHERE id=?").bind(at,id),
    env.DB.prepare("INSERT INTO employer_orders (id) VALUES ('invalid')"),
  ])).rejects.toThrow();
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM employer_funnel_marks WHERE order_id=? AND step='employer_email_verified'").bind(id).first("n")).toBe(0);
  await env.DB.prepare("UPDATE employer_orders SET status='verified',verified_at=? WHERE id=? AND status='unverified'").bind(at,id).run();
  const pay=()=>env.DB.prepare("UPDATE employer_orders SET status='paid',paid_amount=2900,paid_at=? WHERE id=? AND status='verified'").bind(at,id).run();
  await pay(); await pay();
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM employer_funnel_marks WHERE order_id=? AND step='employer_paid'").bind(id).first("n")).toBe(1);
  expect(await env.DB.prepare("SELECT n FROM event_counts WHERE day='2026-10-22' AND event='employer_paid' AND page='one'").first("n")).toBe(1);
});
