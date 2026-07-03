const { TENANT_ID, getSupabaseAdmin } = require("./supabase");
const { getSessionDetail } = require("./sessions");
const {
  normalizeCart,
  getOrderFullTotal,
  mergeCartEdits,
  settleCartLine,
} = require("./billCart");

async function getEditableOrder(orderId) {
  const supabase = getSupabaseAdmin();
  const { data: order, error } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .eq("tenant_id", TENANT_ID)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!order) {
    throw new Error("Замовлення не знайдено");
  }

  if (order.status === "cancelled") {
    throw new Error("Скасоване замовлення не можна змінювати");
  }

  if (!order.session_id) {
    throw new Error("Замовлення не привʼязане до рахунку будинку");
  }

  const { data: session, error: sessionError } = await supabase
    .from("house_sessions")
    .select("id, status")
    .eq("id", order.session_id)
    .eq("tenant_id", TENANT_ID)
    .maybeSingle();

  if (sessionError) {
    throw new Error(sessionError.message);
  }

  if (!session || session.status !== "active") {
    throw new Error("Рахунок уже закрито");
  }

  return order;
}

async function updateOrderCart(orderId, cartInput) {
  const order = await getEditableOrder(orderId);
  const cart = mergeCartEdits(order.cart, cartInput);

  if (cart.length === 0) {
    throw new Error("Замовлення не може бути порожнім — видаліть усе замовлення");
  }

  const total = getOrderFullTotal(cart);
  const supabase = getSupabaseAdmin();
  const { data: updated, error } = await supabase
    .from("orders")
    .update({
      cart,
      total,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .eq("tenant_id", TENANT_ID)
    .select("*")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return updated;
}

async function settleOrderLine(orderId, lineIndex, quantity = 1) {
  const order = await getEditableOrder(orderId);
  const cart = settleCartLine(order.cart, lineIndex, quantity);
  const total = getOrderFullTotal(cart);
  const supabase = getSupabaseAdmin();

  const { data: updated, error } = await supabase
    .from("orders")
    .update({
      cart,
      total,
      updated_at: new Date().toISOString(),
    })
    .eq("id", orderId)
    .eq("tenant_id", TENANT_ID)
    .select("*")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return updated;
}

async function adminUpdateOrderCart(payload) {
  if (!payload.orderId || !Array.isArray(payload.cart)) {
    throw new Error("Missing orderId or cart");
  }

  await updateOrderCart(payload.orderId, payload.cart);

  if (!payload.sessionId) {
    return { ok: true };
  }

  const detail = await getSessionDetail(payload.sessionId);
  return { ok: true, ...detail };
}

async function adminSettleOrderLine(payload) {
  if (!payload.orderId || payload.lineIndex == null) {
    throw new Error("Missing orderId or lineIndex");
  }

  await settleOrderLine(payload.orderId, payload.lineIndex, payload.quantity);

  if (!payload.sessionId) {
    return { ok: true };
  }

  const detail = await getSessionDetail(payload.sessionId);
  return { ok: true, ...detail };
}

module.exports = {
  adminUpdateOrderCart,
  adminSettleOrderLine,
};
