const { validateInitData, sendMessage, answerCallbackQuery } = require("../lib/telegram");
const {
  createOrder,
  notifyAdminNewOrder,
  notifyCustomer,
  handleOrderCallback,
  getUserOrders,
  formatUserOrdersMessage,
} = require("../lib/orders");

const WELCOME_TEXT =
  "✨ Вітаємо в комплексі «Аж у небі»!\n\nНатисніть кнопку нижче, щоб відкрити меню та зробити замовлення:";

function isStartCommand(text) {
  const firstWord = text.trim().split(/\s+/)[0];
  return firstWord === "/start" || firstWord.startsWith("/start@");
}

async function sendWelcomeMessage(chatId, webAppUrl) {
  await sendMessage({
    chat_id: chatId,
    text: WELCOME_TEXT,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "🍽 Відкрити меню",
            web_app: { url: webAppUrl },
          },
        ],
        [{ text: "📋 Мої замовлення", callback_data: "orders:list" }],
      ],
    },
  });
}

function isOrdersCommand(text) {
  const firstWord = text.trim().split(/\s+/)[0];
  return firstWord === "/orders" || firstWord.startsWith("/orders@");
}

async function handleOrder(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { initData, cart, comment, locationNote, paymentMethod } = req.body || {};
    const user = validateInitData(initData);

    if (!user) {
      return res.status(401).json({ ok: false, error: "Invalid initData" });
    }

    const order = await createOrder({
      user,
      cartInput: cart,
      comment,
      locationNote,
      paymentMethod,
    });

    await notifyAdminNewOrder(order);

    await notifyCustomer(
      order,
      `📩 Замовлення отримано!\n\nОчікуйте підтвердження від адміністратора.\nСума: ${order.total} ₴`
    );

    return res.status(200).json({ ok: true, orderId: order.id });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : "Order failed",
    });
  }
}

async function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery.data || "";

  if (data === "orders:list") {
    try {
      const orders = await getUserOrders(callbackQuery.from.id);
      await sendMessage({
        chat_id: callbackQuery.message?.chat?.id || callbackQuery.from.id,
        text: formatUserOrdersMessage(orders),
      });
      await answerCallbackQuery({
        callback_query_id: callbackQuery.id,
      });
    } catch (error) {
      await answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: "Не вдалося завантажити замовлення",
        show_alert: true,
      });
    }
    return;
  }

  const [actionCode, orderId] = data.split(":");

  const actionMap = {
    c: "confirm",
    x: "cancel",
    r: "ready",
  };

  const action = actionMap[actionCode];

  try {
    if (!action || !orderId) {
      throw new Error("Invalid callback");
    }

    await handleOrderCallback(action, orderId);

    await answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      text: "Оновлено",
    });
  } catch (error) {
    await answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      text: "Помилка обробки",
      show_alert: true,
    });
  }
}

async function handleWebhook(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }

  try {
    const update = req.body;

    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
      return res.status(200).send("OK");
    }

    const text = update?.message?.text;

    if (typeof text === "string" && isStartCommand(text)) {
      const webAppUrl = process.env.WEB_APP_URL;
      if (!webAppUrl) {
        throw new Error("WEB_APP_URL is not set");
      }

      await sendWelcomeMessage(update.message.chat.id, webAppUrl);
      return res.status(200).send("OK");
    }

    if (typeof text === "string" && isOrdersCommand(text)) {
      const orders = await getUserOrders(update.message.from.id);
      await sendMessage({
        chat_id: update.message.chat.id,
        text: formatUserOrdersMessage(orders),
      });
    }
  } catch (error) {
    // Повертаємо 200, щоб Telegram не спамив ретраями
  }

  return res.status(200).send("OK");
}

function getRequestPath(req) {
  return (req.url || "").split("?")[0];
}

module.exports = async (req, res) => {
  const path = getRequestPath(req);

  if (path === "/api/order" || path.endsWith("/order")) {
    return handleOrder(req, res);
  }

  return handleWebhook(req, res);
};

module.exports.handleOrder = handleOrder;
module.exports.handleWebhook = handleWebhook;
