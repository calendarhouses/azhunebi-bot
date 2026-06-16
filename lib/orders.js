const { TENANT_ID, getSupabaseAdmin } = require("./supabase");
const { sendMessage, editMessageText } = require("./telegram");

const STATUS_LABELS = {
  pending: "⏳ Очікує",
  preparing: "🍳 Готуємо",
  ready: "✅ Готово",
  cancelled: "❌ Скасовано",
};

function formatCartLines(cart) {
  return cart.map((item) => `• ${item.name} ×${item.quantity} — ${item.price * item.quantity} ₴`).join("\n");
}

function formatAdminOrderMessage(order) {
  const username = order.user_username ? `@${order.user_username}` : "без username";
  const lines = [
    `🚨 Нове замовлення`,
    `Клієнт: ${order.user_first_name} (${username})`,
    `Статус: ${STATUS_LABELS[order.status] || order.status}`,
    "",
    formatCartLines(order.cart),
    "",
    `Сума: ${order.total} ₴`,
  ];

  if (order.location_note) {
    lines.push(`📍 ${order.location_note}`);
  }

  if (order.comment) {
    lines.push(`💬 ${order.comment}`);
  }

  lines.push("", `ID: ${order.id}`);

  return lines.join("\n");
}

function adminKeyboard(order) {
  if (order.status === "pending") {
    return {
      inline_keyboard: [
        [
          { text: "✅ Підтвердити", callback_data: `c:${order.id}` },
          { text: "❌ Скасувати", callback_data: `x:${order.id}` },
        ],
      ],
    };
  }

  if (order.status === "preparing") {
    return {
      inline_keyboard: [
        [{ text: "🍽 Готово", callback_data: `r:${order.id}` }],
      ],
    };
  }

  return undefined;
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
    if (!menuItem || !menuItem.is_available) {
      throw new Error(`Item unavailable: ${line.id}`);
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

async function createOrder({ user, cartInput, comment, locationNote }) {
  const supabase = getSupabaseAdmin();
  const { cart, total } = await validateAndBuildCart(cartInput);

  const { data: order, error } = await supabase
    .from("orders")
    .insert({
      tenant_id: TENANT_ID,
      status: "pending",
      telegram_user_id: user.id,
      user_first_name: user.first_name || "Гість",
      user_username: user.username || null,
      cart,
      total,
      comment: comment || null,
      location_note: locationNote || null,
    })
    .select("*")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return order;
}

async function notifyAdminNewOrder(order) {
  const adminChatId = process.env.ADMIN_TELEGRAM_ID;
  if (!adminChatId) {
    throw new Error("ADMIN_TELEGRAM_ID is not set");
  }

  const message = await sendMessage({
    chat_id: adminChatId,
    text: formatAdminOrderMessage(order),
    reply_markup: adminKeyboard(order),
  });

  const supabase = getSupabaseAdmin();
  await supabase
    .from("orders")
    .update({ admin_message_id: message.message_id })
    .eq("id", order.id);

  return message;
}

async function notifyCustomer(order, text) {
  await sendMessage({
    chat_id: order.telegram_user_id,
    text,
  });
}

async function updateOrderStatus(orderId, status) {
  const supabase = getSupabaseAdmin();

  const { data: order, error } = await supabase
    .from("orders")
    .update({ status })
    .eq("id", orderId)
    .eq("tenant_id", TENANT_ID)
    .select("*")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return order;
}

async function refreshAdminMessage(order) {
  const adminChatId = process.env.ADMIN_TELEGRAM_ID;
  if (!adminChatId || !order.admin_message_id) {
    return;
  }

  const payload = {
    chat_id: adminChatId,
    message_id: order.admin_message_id,
    text: formatAdminOrderMessage(order),
  };

  const keyboard = adminKeyboard(order);
  if (keyboard) {
    payload.reply_markup = keyboard;
  }

  await editMessageText(payload);
}

async function handleOrderCallback(action, orderId) {
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
      return existing;
    }

    const order = await updateOrderStatus(orderId, "preparing");
    await notifyCustomer(
      order,
      "✅ Замовлення прийнято!\n\n🍳 Готуємо для вас. Повідомимо, коли буде готово."
    );
    await refreshAdminMessage(order);
    return order;
  }

  if (action === "cancel") {
    if (existing.status === "cancelled" || existing.status === "ready") {
      return existing;
    }

    const order = await updateOrderStatus(orderId, "cancelled");
    await notifyCustomer(order, "❌ Замовлення скасовано.");
    await refreshAdminMessage(order);
    return order;
  }

  if (action === "ready") {
    if (existing.status !== "preparing") {
      return existing;
    }

    const order = await updateOrderStatus(orderId, "ready");
    await notifyCustomer(
      order,
      "🍽 Ваше замовлення готове!\n\nСмачного! Дякуємо, що обрали «Аж у небі»."
    );
    await refreshAdminMessage(order);
    return order;
  }

  throw new Error("Unknown action");
}

module.exports = {
  createOrder,
  notifyAdminNewOrder,
  notifyCustomer,
  handleOrderCallback,
  formatAdminOrderMessage,
};
