import { ORDER_ID } from "./shared.js";

// ---------------------------------------------------------------- loading

async function loadOrder(db, id) {
  if (typeof id !== "string" || !ORDER_ID.test(id)) return null;
  return db.prepare("SELECT * FROM employer_orders WHERE id = ?").bind(id).first();
}

const orderRoles = async (db, id) =>
  (await db.prepare("SELECT * FROM employer_order_roles WHERE order_id = ? ORDER BY rowid").bind(id).all()).results;

export { loadOrder, orderRoles };
