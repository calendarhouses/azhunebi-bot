const { TENANT_ID, getSupabaseAdmin } = require("./supabase");

const CONFIRMED_STATUSES = ["accepted", "preparing", "ready"];
const CHECKOUT_BLOCKING_STATUSES = ["pending", "accepted", "preparing"];

function isSessionOccupied(orders, totals) {
  const billTotal = totals.confirmedTotal + totals.pendingTotal;
  return (orders?.length || 0) > 0 || billTotal > 0;
}

function getCheckoutBlockingOrders(orders) {
  return (orders || []).filter((order) =>
    CHECKOUT_BLOCKING_STATUSES.includes(order.status)
  );
}

function serializeOrders(orders) {
  const { serializeOrderForApp } = require("./orders");
  return (orders || []).map(serializeOrderForApp);
}

function parseCabinNumber(locationNote) {
  if (!locationNote || typeof locationNote !== "string") {
    return null;
  }

  const match = /будино(?:чок|к)\s*(\d{1,2})/i.exec(locationNote.trim());
  if (!match) {
    return null;
  }

  const number = Number(match[1]);
  if (!Number.isFinite(number) || number < 1 || number > 12) {
    return null;
  }

  return number;
}

function cabinLabel(cabinNumber) {
  return `Будиночок ${cabinNumber}`;
}

function normalizeTelegramUserId(id) {
  const value = Number(id);
  if (!Number.isFinite(value)) {
    throw new Error("Invalid Telegram user id");
  }
  return value;
}

async function getActiveSessionByCabin(cabinNumber) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("house_sessions")
    .select("*")
    .eq("tenant_id", TENANT_ID)
    .eq("cabin_number", cabinNumber)
    .eq("status", "active")
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function getOrCreateActiveSession(cabinNumber) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("get_or_create_active_house_session", {
    p_tenant_id: TENANT_ID,
    p_cabin_number: cabinNumber,
  });

  if (error) {
    const existing = await getActiveSessionByCabin(cabinNumber);
    if (existing) {
      return existing;
    }
    throw new Error(error.message);
  }

  const session = Array.isArray(data) ? data[0] : data;

  if (!session) {
    throw new Error("Failed to open house session");
  }

  return session;
}

async function moveUserOrdersToSession(
  telegramUserId,
  fromSessionId,
  toSessionId,
  cabinNumber
) {
  if (!fromSessionId || fromSessionId === toSessionId) {
    return;
  }

  const supabase = getSupabaseAdmin();
  const userId = normalizeTelegramUserId(telegramUserId);
  const { error } = await supabase
    .from("orders")
    .update({
      session_id: toSessionId,
      location_note: cabinLabel(cabinNumber),
    })
    .eq("tenant_id", TENANT_ID)
    .eq("telegram_user_id", userId)
    .eq("session_id", fromSessionId)
    .neq("status", "cancelled");

  if (error) {
    throw new Error(error.message);
  }
}

async function getUserBinding(telegramUserId) {
  const supabase = getSupabaseAdmin();
  const userId = normalizeTelegramUserId(telegramUserId);

  const { data, error } = await supabase
    .from("house_guest_bindings")
    .select("*")
    .eq("tenant_id", TENANT_ID)
    .eq("telegram_user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function deleteUserBinding(telegramUserId) {
  const supabase = getSupabaseAdmin();
  const userId = normalizeTelegramUserId(telegramUserId);

  const { error } = await supabase
    .from("house_guest_bindings")
    .delete()
    .eq("tenant_id", TENANT_ID)
    .eq("telegram_user_id", userId);

  if (error) {
    throw new Error(error.message);
  }
}

async function userHasSessionOrders(telegramUserId, sessionId) {
  const supabase = getSupabaseAdmin();
  const userId = normalizeTelegramUserId(telegramUserId);

  const { count, error } = await supabase
    .from("orders")
    .select("id", { count: "exact", head: true })
    .eq("tenant_id", TENANT_ID)
    .eq("session_id", sessionId)
    .eq("telegram_user_id", userId)
    .neq("status", "cancelled");

  if (error) {
    throw new Error(error.message);
  }

  return (count || 0) > 0;
}

/**
 * Validates binding against an active session and the guest's own orders.
 * Drops stale rows (closed session, or no non-cancelled orders in session).
 */
async function reconcileGuestBinding(telegramUserId) {
  const userId = normalizeTelegramUserId(telegramUserId);
  const binding = await getUserBinding(userId);

  if (!binding) {
    return null;
  }

  const supabase = getSupabaseAdmin();
  const { data: session, error } = await supabase
    .from("house_sessions")
    .select("*")
    .eq("id", binding.session_id)
    .eq("tenant_id", TENANT_ID)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!session || session.status !== "active") {
    await deleteUserBinding(userId);
    return null;
  }

  const hasOrders = await userHasSessionOrders(userId, session.id);
  if (!hasOrders) {
    await deleteUserBinding(userId);
    return null;
  }

  if (session.cabin_number !== binding.cabin_number) {
    await bindUserToSession(userId, session.cabin_number, session.id);
  }

  return { binding, session };
}

async function unbindGuestUser(telegramUserId) {
  await deleteUserBinding(telegramUserId);
  return { ok: true };
}

async function bindUserToSession(telegramUserId, cabinNumber, sessionId) {
  const supabase = getSupabaseAdmin();
  const userId = normalizeTelegramUserId(telegramUserId);

  const { error } = await supabase.from("house_guest_bindings").upsert(
    {
      tenant_id: TENANT_ID,
      telegram_user_id: userId,
      cabin_number: cabinNumber,
      session_id: sessionId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id,telegram_user_id" }
  );

  if (error) {
    throw new Error(error.message);
  }
}

async function unbindSessionUsers(sessionId) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("house_guest_bindings")
    .delete()
    .eq("tenant_id", TENANT_ID)
    .eq("session_id", sessionId);

  if (error) {
    throw new Error(error.message);
  }
}

function sumOrders(orders, statuses) {
  return (orders || [])
    .filter((order) => statuses.includes(order.status))
    .reduce((sum, order) => sum + Number(order.total || 0), 0);
}

async function getSessionOrders(sessionId) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("tenant_id", TENANT_ID)
    .eq("session_id", sessionId)
    .neq("status", "cancelled")
    .order("created_at", { ascending: false });

  if (error) {
    throw new Error(error.message);
  }

  return data || [];
}

function calcSessionTotals(orders) {
  return {
    confirmedTotal: sumOrders(orders, CONFIRMED_STATUSES),
    pendingTotal: sumOrders(orders, ["pending"]),
  };
}

async function resolveSessionForOrder(telegramUserId, locationNote) {
  const userId = normalizeTelegramUserId(telegramUserId);
  await reconcileGuestBinding(userId);
  const binding = await getUserBinding(userId);
  const cabinFromNote = parseCabinNumber(locationNote);

  let cabinNumber = binding?.cabin_number || cabinFromNote;

  if (!cabinNumber) {
    return null;
  }

  const session = await getOrCreateActiveSession(cabinNumber);
  await bindUserToSession(userId, cabinNumber, session.id);

  return {
    sessionId: session.id,
    cabinNumber,
    locationNote: cabinLabel(cabinNumber),
  };
}

async function attachOrderToSession(orderId, sessionId) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("orders")
    .update({ session_id: sessionId })
    .eq("id", orderId)
    .eq("tenant_id", TENANT_ID);

  if (error) {
    throw new Error(error.message);
  }
}

async function getHouseBindingForUser(telegramUserId) {
  const reconciled = await reconcileGuestBinding(telegramUserId);

  if (!reconciled) {
    return null;
  }

  const { session } = reconciled;

  return {
    sessionId: session.id,
    cabinNumber: session.cabin_number,
    cabinLabel: cabinLabel(session.cabin_number),
  };
}

async function getRunningTabForUser(telegramUserId) {
  const reconciled = await reconcileGuestBinding(telegramUserId);

  if (!reconciled) {
    return null;
  }

  const { session } = reconciled;
  const orders = await getSessionOrders(session.id);
  const totals = calcSessionTotals(orders);

  return {
    sessionId: session.id,
    cabinNumber: session.cabin_number,
    cabinLabel: cabinLabel(session.cabin_number),
    confirmedTotal: totals.confirmedTotal,
    pendingTotal: totals.pendingTotal,
    orders: serializeOrders(orders),
  };
}

async function changeGuestHouse(telegramUserId, newCabinNumber) {
  const cabinNumber = Number(newCabinNumber);
  if (!Number.isFinite(cabinNumber) || cabinNumber < 1 || cabinNumber > 12) {
    throw new Error("Невірний номер будинку");
  }

  const userId = normalizeTelegramUserId(telegramUserId);
  const binding = await getUserBinding(userId);
  const session = await getOrCreateActiveSession(cabinNumber);

  if (binding?.session_id && binding.session_id !== session.id) {
    await moveUserOrdersToSession(
      userId,
      binding.session_id,
      session.id,
      cabinNumber
    );
  }

  await bindUserToSession(userId, cabinNumber, session.id);

  return getRunningTabForUser(userId);
}

async function getSessionsDashboard() {
  const supabase = getSupabaseAdmin();
  const { data: activeSessions, error } = await supabase
    .from("house_sessions")
    .select("*")
    .eq("tenant_id", TENANT_ID)
    .eq("status", "active");

  if (error) {
    throw new Error(error.message);
  }

  const sessionByCabin = new Map(
    (activeSessions || []).map((session) => [session.cabin_number, session])
  );

  const cabins = [];

  for (let cabinNumber = 1; cabinNumber <= 12; cabinNumber += 1) {
    const session = sessionByCabin.get(cabinNumber) || null;
    let confirmedTotal = 0;
    let pendingTotal = 0;
    let orderCount = 0;

    let occupied = false;

    if (session) {
      const orders = await getSessionOrders(session.id);
      const totals = calcSessionTotals(orders);
      confirmedTotal = totals.confirmedTotal;
      pendingTotal = totals.pendingTotal;
      orderCount = orders.length;
      occupied = isSessionOccupied(orders, totals);
    }

    cabins.push({
      cabinNumber,
      cabinLabel: cabinLabel(cabinNumber),
      session:
        session && occupied
          ? {
              id: session.id,
              status: session.status,
              checkedInAt: session.checked_in_at,
            }
          : null,
      confirmedTotal,
      pendingTotal,
      orderCount,
    });
  }

  return cabins;
}

async function getSessionDetail(sessionId) {
  const supabase = getSupabaseAdmin();
  const { data: session, error } = await supabase
    .from("house_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("tenant_id", TENANT_ID)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!session) {
    throw new Error("Session not found");
  }

  const orders = await getSessionOrders(session.id);
  const totals = calcSessionTotals(orders);

  const { data: bindings, error: bindingsError } = await supabase
    .from("house_guest_bindings")
    .select("telegram_user_id, updated_at")
    .eq("tenant_id", TENANT_ID)
    .eq("session_id", session.id);

  if (bindingsError) {
    throw new Error(bindingsError.message);
  }

  return {
    session: {
      id: session.id,
      cabinNumber: session.cabin_number,
      cabinLabel: cabinLabel(session.cabin_number),
      status: session.status,
      checkedInAt: session.checked_in_at,
      checkedOutAt: session.checked_out_at || session.closed_at,
      closedTotal: session.closed_total ? Number(session.closed_total) : null,
      closedAt: session.closed_at || session.checked_out_at,
      finalTotal: session.final_total
        ? Number(session.final_total)
        : session.closed_total
          ? Number(session.closed_total)
          : null,
    },
    confirmedTotal: totals.confirmedTotal,
    pendingTotal: totals.pendingTotal,
    orders: serializeOrders(orders),
    guestCount: (bindings || []).length,
    checkoutBlocked: getCheckoutBlockingOrders(orders).length > 0,
  };
}

async function moveOrderToHouse(orderId, targetCabinNumber) {
  const cabinNumber = Number(targetCabinNumber);
  if (!Number.isFinite(cabinNumber) || cabinNumber < 1 || cabinNumber > 12) {
    throw new Error("Невірний номер будинку");
  }

  const supabase = getSupabaseAdmin();
  const session = await getOrCreateActiveSession(cabinNumber);

  const { data: order, error } = await supabase
    .from("orders")
    .update({
      session_id: session.id,
      location_note: cabinLabel(cabinNumber),
    })
    .eq("id", orderId)
    .eq("tenant_id", TENANT_ID)
    .select("*")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return order;
}

async function checkOutSession(sessionId, closedBy) {
  const supabase = getSupabaseAdmin();
  const { data: session, error: fetchError } = await supabase
    .from("house_sessions")
    .select("*")
    .eq("id", sessionId)
    .eq("tenant_id", TENANT_ID)
    .maybeSingle();

  if (fetchError) {
    throw new Error(fetchError.message);
  }

  if (!session) {
    throw new Error("Session not found");
  }

  if (session.status !== "active") {
    throw new Error("Сесія вже закрита");
  }

  const orders = await getSessionOrders(session.id);
  const totals = calcSessionTotals(orders);

  const blockingOrders = getCheckoutBlockingOrders(orders);
  if (blockingOrders.length > 0) {
    throw new Error(
      `Неможливо розрахувати: ${blockingOrders.length} замовл. ще не готові (очікують або готуються). Спочатку завершіть або скасуйте їх.`
    );
  }

  const finalTotal = totals.confirmedTotal;
  const closedAt = new Date().toISOString();

  const { error: closeError } = await supabase
    .from("house_sessions")
    .update({
      status: "closed",
      checked_out_at: closedAt,
      closed_at: closedAt,
      closed_total: finalTotal,
      final_total: finalTotal,
      closed_by: closedBy || null,
      updated_at: closedAt,
    })
    .eq("id", session.id)
    .eq("status", "active");

  if (closeError) {
    throw new Error(closeError.message);
  }

  const { data: closedRow, error: verifyError } = await supabase
    .from("house_sessions")
    .select("id, status")
    .eq("id", session.id)
    .eq("tenant_id", TENANT_ID)
    .maybeSingle();

  if (verifyError || !closedRow || closedRow.status !== "closed") {
    throw new Error("Не вдалося закрити сесію");
  }

  await unbindSessionUsers(session.id);

  return {
    sessionId: session.id,
    cabinNumber: session.cabin_number,
    finalTotal,
  };
}

async function getClosedSessionsArchive(limit = 40) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("house_sessions")
    .select(
      "id, cabin_number, checked_in_at, closed_at, checked_out_at, final_total, closed_total"
    )
    .eq("tenant_id", TENANT_ID)
    .eq("status", "closed")
    .order("closed_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) {
    throw new Error(error.message);
  }

  return (data || []).map((session) => ({
    id: session.id,
    cabinNumber: session.cabin_number,
    cabinLabel: cabinLabel(session.cabin_number),
    checkedInAt: session.checked_in_at,
    closedAt: session.closed_at || session.checked_out_at,
    finalTotal: session.final_total
      ? Number(session.final_total)
      : session.closed_total
        ? Number(session.closed_total)
        : null,
  }));
}

async function deleteClosedSession(sessionId) {
  const supabase = getSupabaseAdmin();

  const { data: session, error: fetchError } = await supabase
    .from("house_sessions")
    .select("id, status")
    .eq("id", sessionId)
    .eq("tenant_id", TENANT_ID)
    .maybeSingle();

  if (fetchError) {
    throw new Error(fetchError.message);
  }

  if (!session) {
    throw new Error("Session not found");
  }

  if (session.status !== "closed") {
    throw new Error("Можна видаляти лише архівні рахунки");
  }

  const { error: detachError } = await supabase
    .from("orders")
    .update({ session_id: null })
    .eq("session_id", sessionId)
    .eq("tenant_id", TENANT_ID);

  if (detachError) {
    throw new Error(detachError.message);
  }

  const { error: deleteError } = await supabase
    .from("house_sessions")
    .delete()
    .eq("id", sessionId)
    .eq("tenant_id", TENANT_ID)
    .eq("status", "closed");

  if (deleteError) {
    throw new Error(deleteError.message);
  }

  return { sessionId };
}

module.exports = {
  parseCabinNumber,
  cabinLabel,
  resolveSessionForOrder,
  attachOrderToSession,
  getHouseBindingForUser,
  getRunningTabForUser,
  changeGuestHouse,
  unbindGuestUser,
  getSessionsDashboard,
  getSessionDetail,
  moveOrderToHouse,
  checkOutSession,
  calcSessionTotals,
  getClosedSessionsArchive,
  deleteClosedSession,
  CONFIRMED_STATUSES,
};
