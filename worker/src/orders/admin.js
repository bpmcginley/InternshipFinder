const ORDERS_SHOWN = 100;

// ---------------------------------------------------------------- admin (Bruce's terminal)

// GET /admin/orders: the recent orders, without the employer's name or email.
export async function listOrders(db) {
  const { results } = await db.prepare(
    "SELECT o.id, o.created, o.status, o.package, o.start_day AS start, COALESCE(o.paid_amount, o.price) AS amount, " +
    "o.company, (SELECT COUNT(*) FROM employer_order_roles r WHERE r.order_id = o.id) AS roles " +
    "FROM employer_orders o ORDER BY o.created DESC, o.id LIMIT ?",
  ).bind(ORDERS_SHOWN).all();
  return { orders: results };
}
