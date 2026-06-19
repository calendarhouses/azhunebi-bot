const { TENANT_ID, getSupabaseAdmin } = require("./supabase");
const {
  sendMessage,
  editMessageText,
  editMessageCaption,
  editMessageReplyMarkup,
  sendPhotoFromDataUrl,
} = require("./telegram");
const { sendLoveSticker, sendEmptySticker } = require("./stickers");
const {
  resolveSessionForOrder,
} = require("./sessions");

const STATUS_LABELS = {
  pending: "⏳ Очікуємо підтвердження",
  accepted: "✅ Прийнято",
  preparing: "🍳 Готуємо",
  ready: "🍽 Готово",
  cancelled: "❌ Скасовано",
};

const STATUS_TOAST_LABELS = {
  pending: "Очікуємо підтвердження",
  accepted: "Замовлення прийнято",
  preparing: "Готуємо для вас",
  ready: "Замовлення готове!",
  cancelled: "Замовлення скасовано",
};

const READY_VISIBLE_MS = 60 * 60 * 1000;
const CANCELLED_VISIBLE_MS = 24 * 60 * 60 * 1000;
const ADMIN_TEXT_FALLBACK_MS = 2 * 60 * 1000;

function formatCartLines(cart) {
  return cart
    .map(
      (item) =>
        ` • ${item.name} ×${item.quantity} — ${item.price * item.quantity} ₴`
    )
    .join("\n");
}

function formatScheduledFor(isoDate) {
  if (!isoDate) {
    return null;
  }

  return new Date(isoDate).toLocaleString("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCabinDisplay(cabin) {
  const cabinLabel = cabin ? String(cabin).trim() : "";
  if (!cabinLabel) {
    return "";
  }
  const cabinMatch = /(\d{1,2})/.exec(cabinLabel);
  return cabinMatch ? `Будиночок ${cabinMatch[1]}` : cabinLabel;
}

function formatTableDeliveryLabel(tableNum) {
  return `За столиком №${tableNum}`;
}

function formatLocationDisplay(cabin, table) {
  const cabinLabel = cabin ? String(cabin).trim() : "";
  const tableLabel = table ? String(table).trim() : "";

  if (tableLabel && cabinLabel) {
    const match = /№\s*(\d{1,2})/.exec(tableLabel);
    const tableNum = match ? match[1] : null;
    const tableLine = tableNum
      ? formatTableDeliveryLabel(tableNum)
      : tableLabel;
    return `${tableLine} (${formatCabinDisplay(cabinLabel)})`;
  }

  if (tableLabel) {
    const match = /№\s*(\d{1,2})/.exec(tableLabel);
    if (match) {
      return formatTableDeliveryLabel(match[1]);
    }
    return tableLabel;
  }

  return cabinLabel ? formatCabinDisplay(cabinLabel) : null;
}

function formatAdminLocationLine(order) {
  return formatLocationDisplay(order.location_note, order.table_number);
}

function formatAdminOrderMessage(order) {
  const username = order.user_username
    ? `@${order.user_username}`
    : "без username";
  const lines = [
    "🔔 Нове замовлення!",
    `👤 ${order.user_first_name} (${username})`,
  ];

  const locationLine = formatAdminLocationLine(order);
  if (locationLine) {
    lines.push(`📍 ${locationLine}`);
  }

  lines.push("", "📝 Замовлення:", formatCartLines(order.cart), "");

  if (order.scheduled_for) {
    lines.push(`🕐 Подача: ${formatScheduledFor(order.scheduled_for)}`);
  }

  if (order.comment) {
    lines.push(`💬 ${order.comment}`);
  }

  lines.push(`💳 Сума: ${order.total} ₴`);

  const statusLabel = STATUS_LABELS[order.status] || order.status;
  lines.push(`${statusLabel}...`);

  return lines.join("\n");
}

// Short caption under the receipt photo — guest + status only.
function buildAdminCaption(order) {
  const username = order.user_username
    ? `@${order.user_username}`
    : "без username";

  return `👤 ${order.user_first_name} (${username})\n${STATUS_LABELS[order.status] || order.status}`;
}

function adminKeyboard(order) {
  if (order.status === "pending") {
    return {
      inline_keyboard: [
        [
          { text: "✅ Прийняти", callback_data: `accept_${order.id}` },
          { text: "❌ Скасувати", callback_data: `cancel_${order.id}` },
        ],
      ],
    };
  }

  if (order.status === "accepted") {
    return {
      inline_keyboard: [
        [
          {
            text: "🍳 Почати готувати",
            callback_data: `prepare_${order.id}`,
          },
          { text: "❌ Скасувати", callback_data: `cancel_${order.id}` },
        ],
      ],
    };
  }

  if (order.status === "preparing") {
    return {
      inline_keyboard: [
        [{ text: "🍽 Готово", callback_data: `ready_${order.id}` }],
      ],
    };
  }

  return undefined;
}

function parseScheduledFor(value) {
  if (!value || typeof value !== "string") {
    return null;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Невірний час подачі");
  }

  const minLeadMs = 60 * 60 * 1000;
  if (date.getTime() < Date.now() + minLeadMs) {
    throw new Error("Час подачі має бути щонайменше через 1 годину від зараз");
  }

  return date.toISOString();
}

function isOrderVisibleInApp(order) {
  if (order.status === "cancelled") {
    const updatedAt = order.updated_at || order.created_at;
    if (!updatedAt) {
      return false;
    }
    return (
      Date.now() - new Date(updatedAt).getTime() < CANCELLED_VISIBLE_MS
    );
  }

  if (["pending", "accepted", "preparing"].includes(order.status)) {
    return true;
  }

  if (order.status === "ready") {
    const readyAt = order.ready_at || order.updated_at;
    if (!readyAt) {
      return false;
    }

    return Date.now() - new Date(readyAt).getTime() < READY_VISIBLE_MS;
  }

  return false;
}

async function validateAndBuildCart(cartInput) {
  if (!Array.isArray(cartInput) || cartInput.length === 0) {
    throw new Error("Cart is empty");
  }

  const supabase = getSupabaseAdmin();
  const ids = cartInput.map((item) => item.id);

  const { data: menuItems, error } = await supabase
    .from("menu_items")
    .select("id, name, price, is_available")
    .eq("tenant_id", TENANT_ID)
    .in("id", ids);

  if (error) {
    throw new Error(error.message);
  }

  const menuMap = new Map((menuItems || []).map((item) => [item.id, item]));
  const validatedCart = [];
  let total = 0;

  for (const line of cartInput) {
    const quantity = Number(line.quantity);
    if (!line.id || !Number.isInteger(quantity) || quantity < 1) {
      throw new Error("Invalid cart line");
    }

    const menuItem = menuMap.get(line.id);
    if (!menuItem) {
      throw new Error("Одна зі страв у кошику більше не існує в меню. Будь ласка, оновіть кошик.");
    }
    if (!menuItem.is_available) {
      throw new Error(`На жаль, страва «${menuItem.name}» тимчасово недоступна. Видаліть її з кошика і спробуйте знову.`);
    }

    const price = Number(menuItem.price);
    validatedCart.push({
      id: menuItem.id,
      name: menuItem.name,
      price,
      quantity,
    });
    total += price * quantity;
  }

  return { cart: validatedCart, total };
}

async function createOrder({
  user,
  cartInput,
  comment,
  locationNote,
  tableNumber,
  paymentMethod,
  scheduledFor,
}) {
  const supabase = getSupabaseAdmin();
  const { cart, total } = await validateAndBuildCart(cartInput);

  const normalizedPayment =
    paymentMethod === "card" || paymentMethod === "cash"
      ? paymentMethod
      : "cash";

  const scheduled_for = scheduledFor ? parseScheduledFor(scheduledFor) : null;

  const sessionContext = await resolveSessionForOrder(user.id, locationNote);
  const effectiveLocationNote =
    sessionContext?.locationNote || locationNote || null;

  const { data: order, error } = await supabase
    .from("orders")
    .insert({
      tenant_id: TENANT_ID,
      status: "pending",
      telegram_user_id: normalizeTelegramUserId(user.id),
      user_first_name: user.first_name || "Гість",
      user_username: user.username || null,
      cart,
      total,
      comment: comment || null,
      location_note: effectiveLocationNote,
      table_number: tableNumber || null,
      payment_method: normalizedPayment,
      scheduled_for,
      session_id: sessionContext?.sessionId || null,
    })
    .select("*")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  if (sessionContext?.sessionId) {
    const { bindUserToSession } = require("./sessions");
    await bindUserToSession(
      user.id,
      sessionContext.cabinNumber,
      sessionContext.sessionId
    );
  }

  return order;
}

async function notifyAdminNewOrder(order, screenshot) {
  const adminChatId = process.env.ADMIN_TELEGRAM_ID;
  if (!adminChatId) {
    throw new Error("ADMIN_TELEGRAM_ID is not set");
  }

  let message = null;

  // Premium path: the browser-rendered receipt card as a photo.
  if (screenshot && typeof screenshot === "string") {
    try {
      message = await sendPhotoFromDataUrl({
        chat_id: adminChatId,
        dataUrl: screenshot,
        caption: buildAdminCaption(order),
        reply_markup: adminKeyboard(order),
      });
    } catch (error) {
      console.error("[order] sendPhoto failed, falling back to text", error);
    }
  }

  // Fallback: plain text message (also used if no screenshot was sent).
  if (!message) {
    message = await sendMessage({
      chat_id: adminChatId,
      text: formatAdminOrderMessage(order),
      reply_markup: adminKeyboard(order),
    });
  }

  const supabase = getSupabaseAdmin();
  const { data: linked } = await supabase
    .from("orders")
    .update({ admin_message_id: message.message_id })
    .eq("id", order.id)
    .is("admin_message_id", null)
    .select("id")
    .maybeSingle();

  if (!linked) {
    console.warn(
      "[order] admin_message_id already set — skipping duplicate link",
      order.id
    );
  }

  return message;
}

async function attachOrderScreenshot(telegramUserId, orderId, screenshot) {
  const supabase = getSupabaseAdmin();
  const userId = normalizeTelegramUserId(telegramUserId);

  const { data: order, error } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .eq("tenant_id", TENANT_ID)
    .eq("telegram_user_id", userId)
    .maybeSingle();

  if (error || !order) {
    throw new Error("Order not found");
  }

  if (order.admin_message_id) {
    return order;
  }

  const { data: fresh, error: freshError } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .eq("tenant_id", TENANT_ID)
    .maybeSingle();

  if (freshError || !fresh) {
    throw new Error("Order not found");
  }

  if (fresh.admin_message_id) {
    return fresh;
  }

  await notifyAdminNewOrder(fresh, screenshot);
  return fresh;
}

async function processAdminNotifyFallback() {
  const supabase = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - ADMIN_TEXT_FALLBACK_MS).toISOString();

  const { data: orders, error } = await supabase
    .from("orders")
    .select("*")
    .eq("tenant_id", TENANT_ID)
    .eq("status", "pending")
    .is("admin_message_id", null)
    .lte("created_at", cutoff);

  if (error) {
    throw new Error(error.message);
  }

  let updated = 0;

  for (const order of orders || []) {
    try {
      await notifyAdminNewOrder(order, null);
      updated += 1;
    } catch (notifyError) {
      console.error("[cron] admin text fallback failed", order.id, notifyError);
    }
  }

  return { updated };
}

async function notifyCustomerReady(order) {
  const chatId = order.telegram_user_id;

  try {
    await sendLoveSticker(chatId);
  } catch (error) {
    console.error("[ready] sticker failed", error);
  }

  await sendMessage({
    chat_id: chatId,
    text:
      "🍽 Ваше замовлення готове!\n\nСмачного! Дякуємо, що обрали «Аж у небі».",
  });
}

async function notifyCustomerCancelled(order) {
  const chatId = order.telegram_user_id;

  try {
    await sendEmptySticker(chatId);
  } catch (error) {
    console.error("[cancel] sticker failed", error);
  }

  try {
    await sendMessage({
      chat_id: chatId,
      text:
        "❌ Ваше замовлення скасовано.\n\nЯкщо це помилка — оформіть нове замовлення в меню.",
    });
  } catch (error) {
    console.error("[cancel] message failed", error);
  }
}

async function updateOrderStatus(orderId, status) {
  const supabase = getSupabaseAdmin();
  const updates = { status };

  if (status === "ready") {
    updates.ready_at = new Date().toISOString();
  }

  const { data: order, error } = await supabase
    .from("orders")
    .update(updates)
    .eq("id", orderId)
    .eq("tenant_id", TENANT_ID)
    .select("*")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return order;
}

async function refreshAdminMessage(order, messageContext) {
  const chatId =
    messageContext?.chatId || process.env.ADMIN_TELEGRAM_ID || null;
  const messageId = Number(
    messageContext?.messageId ?? order.admin_message_id
  );

  if (!chatId || !Number.isFinite(messageId)) {
    return false;
  }

  const replyMarkup = adminKeyboard(order) || { inline_keyboard: [] };
  const caption = buildAdminCaption(order);
  let updated = false;

  // Update inline buttons first — works for both photo and text messages.
  try {
    await editMessageReplyMarkup({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup,
    });
    updated = true;
  } catch (error) {
    console.error("[order] editMessageReplyMarkup failed", {
      orderId: order.id,
      messageId,
      error,
    });
  }

  try {
    await editMessageCaption({
      chat_id: chatId,
      message_id: messageId,
      caption,
      reply_markup: replyMarkup,
    });
    return true;
  } catch {
    // Not a photo message — fall through to editMessageText.
  }

  try {
    await editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: formatAdminOrderMessage(order),
      reply_markup: replyMarkup,
    });
    return true;
  } catch (error) {
    console.error("[order] failed to refresh admin message", {
      orderId: order.id,
      messageId,
      error,
    });
  }

  return updated;
}

async function syncAdminMessageId(orderId, messageId) {
  if (!Number.isFinite(messageId)) {
    return;
  }

  const supabase = getSupabaseAdmin();
  await supabase
    .from("orders")
    .update({ admin_message_id: messageId })
    .eq("id", orderId)
    .eq("tenant_id", TENANT_ID);
}

async function finishOrderCallback(order, messageContext, statusChanged) {
  if (messageContext?.messageId) {
    await syncAdminMessageId(order.id, messageContext.messageId);
  }

  const messageRefreshed = await refreshAdminMessage(order, messageContext);

  return {
    order,
    statusChanged,
    messageRefreshed,
  };
}

async function handleOrderCallback(action, orderId, messageContext) {
  const supabase = getSupabaseAdmin();

  const { data: existing, error: fetchError } = await supabase
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .eq("tenant_id", TENANT_ID)
    .single();

  if (fetchError || !existing) {
    throw new Error("Order not found");
  }

  if (action === "confirm") {
    if (existing.status !== "pending") {
      return finishOrderCallback(existing, messageContext, false);
    }

    const order = await updateOrderStatus(orderId, "accepted");
    return finishOrderCallback(order, messageContext, true);
  }

  if (action === "prepare") {
    if (existing.status !== "accepted") {
      return finishOrderCallback(existing, messageContext, false);
    }

    const order = await updateOrderStatus(orderId, "preparing");
    return finishOrderCallback(order, messageContext, true);
  }

  if (action === "cancel") {
    if (existing.status === "cancelled" || existing.status === "ready") {
      return finishOrderCallback(existing, messageContext, false);
    }

    const order = await updateOrderStatus(orderId, "cancelled");
    try {
      await notifyCustomerCancelled(order);
    } catch (error) {
      console.error("[cancel] customer notify failed", error);
    }
    return finishOrderCallback(order, messageContext, true);
  }

  if (action === "ready") {
    if (existing.status !== "preparing") {
      return finishOrderCallback(existing, messageContext, false);
    }

    const order = await updateOrderStatus(orderId, "ready");
    await notifyCustomerReady(order);
    return finishOrderCallback(order, messageContext, true);
  }

  throw new Error("Unknown action");
}

async function processScheduledOrders() {
  const supabase = getSupabaseAdmin();
  const prepareThreshold = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const { data: orders, error } = await supabase
    .from("orders")
    .select("*")
    .eq("tenant_id", TENANT_ID)
    .eq("status", "accepted")
    .not("scheduled_for", "is", null)
    .lte("scheduled_for", prepareThreshold);

  if (error) {
    throw new Error(error.message);
  }

  let updated = 0;

  for (const order of orders || []) {
    const updatedOrder = await updateOrderStatus(order.id, "preparing");
    await refreshAdminMessage(updatedOrder);
    updated += 1;
  }

  return { updated };
}

function normalizeTelegramUserId(id) {
  const value = Number(id);
  if (!Number.isFinite(value)) {
    throw new Error("Invalid Telegram user id");
  }
  return value;
}

function serializeOrderForApp(order) {
  return {
    id: order.id,
    status: order.status,
    total: Number(order.total),
    cart: order.cart,
    comment: order.comment,
    locationNote: order.location_note,
    tableNumber: order.table_number,
    paymentMethod: order.payment_method,
    scheduledFor: order.scheduled_for,
    readyAt: order.ready_at,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    statusLabel: STATUS_TOAST_LABELS[order.status] || order.status,
    userFirstName: order.user_first_name || "Гість",
    telegramUserId: Number(order.telegram_user_id) || null,
  };
}

const STALE_SESSION_STATUSES = ["pending", "accepted", "preparing"];

async function getClosedSessionIdSet(sessionIds) {
  if (!sessionIds.length) {
    return new Set();
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("house_sessions")
    .select("id")
    .eq("tenant_id", TENANT_ID)
    .eq("status", "closed")
    .in("id", sessionIds);

  if (error) {
    throw new Error(error.message);
  }

  return new Set((data || []).map((row) => row.id));
}

function isOrderStaleAfterSessionClose(order, closedSessionIds) {
  if (!order.session_id || !closedSessionIds.has(order.session_id)) {
    return false;
  }

  return STALE_SESSION_STATUSES.includes(order.status);
}

async function getActiveUserOrders(telegramUserId) {
  const supabase = getSupabaseAdmin();
  const userId = normalizeTelegramUserId(telegramUserId);

  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("tenant_id", TENANT_ID)
    .eq("telegram_user_id", userId)
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) {
    throw new Error(error.message);
  }

  let rows = data || [];

  if (!rows.length) {
    const { data: fallbackRows, error: fallbackError } = await supabase
      .from("orders")
      .select("*")
      .eq("tenant_id", TENANT_ID)
      .filter("telegram_user_id", "eq", String(userId))
      .order("created_at", { ascending: false })
      .limit(30);

    if (!fallbackError && fallbackRows?.length) {
      rows = fallbackRows;
    }
  }

  const sessionIds = [
    ...new Set(rows.map((row) => row.session_id).filter(Boolean)),
  ];
  const closedSessionIds = await getClosedSessionIdSet(sessionIds);

  return rows
    .filter((order) => !isOrderStaleAfterSessionClose(order, closedSessionIds))
    .filter(isOrderVisibleInApp)
    .map(serializeOrderForApp);
}

async function getUserOrderById(telegramUserId, orderId) {
  const supabase = getSupabaseAdmin();
  const userId = normalizeTelegramUserId(telegramUserId);

  const { data, error } = await supabase
    .from("orders")
    .select("*")
    .eq("tenant_id", TENANT_ID)
    .eq("telegram_user_id", userId)
    .eq("id", orderId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data || !isOrderVisibleInApp(data)) {
    return null;
  }

  if (data.session_id) {
    const closedSessionIds = await getClosedSessionIdSet([data.session_id]);
    if (isOrderStaleAfterSessionClose(data, closedSessionIds)) {
      return null;
    }
  }

  return serializeOrderForApp(data);
}

function formatOrderDate(isoDate) {
  const date = new Date(isoDate);
  return date.toLocaleString("uk-UA", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function getUserOrders(telegramUserId, limit = 8) {
  const orders = await getActiveUserOrders(telegramUserId);
  return orders.slice(0, limit);
}

function formatUserOrdersMessage(orders) {
  if (!orders.length) {
    return "📋 Немає активних замовлень.\n\nВідкрийте меню в Telegram, щоб оформити замовлення та слідкувати за статусом.";
  }

  const lines = ["📋 Ваші замовлення:", ""];

  orders.forEach((order, index) => {
    const status = STATUS_LABELS[order.status] || order.status;

    lines.push(`${index + 1}. ${formatOrderDate(order.createdAt)}`);
    lines.push(`   ${status} • ${order.total} ₴`);

    if (order.locationNote || order.tableNumber) {
      const locationLine = formatLocationDisplay(
        order.locationNote,
        order.tableNumber
      );
      if (locationLine) {
        lines.push(`   📍 ${locationLine}`);
      }
    }

    if (order.scheduledFor) {
      lines.push(`   🕐 Подача: ${formatScheduledFor(order.scheduledFor)}`);
    }

    lines.push("");
  });

  lines.push("Детальний статус — у Web App меню (кнопка 📋).");

  return lines.join("\n");
}

module.exports = {
  STATUS_LABELS,
  STATUS_TOAST_LABELS,
  createOrder,
  notifyAdminNewOrder,
  attachOrderScreenshot,
  notifyCustomerReady,
  notifyCustomerCancelled,
  handleOrderCallback,
  formatAdminOrderMessage,
  processScheduledOrders,
  processAdminNotifyFallback,
  serializeOrderForApp,
  getActiveUserOrders,
  getUserOrderById,
  getUserOrders,
  formatUserOrdersMessage,
  isOrderVisibleInApp,
};
