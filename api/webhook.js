const { validateInitData, sendMessage, answerCallbackQuery } = require("../lib/telegram");
const { handleOrderApi, parseBody } = require("../lib/order-api");
const {
  handleOrderCallback,
  getUserOrders,
} = require("../lib/orders");

const WELCOME_TEXT =
  "✨ Вітаємо в комплексі «Аж у небі»!\n\nНатисніть кнопку нижче, щоб відкрити меню та зробити замовлення:";

function isStartCommand(text) {
  const firstWord = text.trim().split(/\s+/)[0];
  return firstWord === "/start" || firstWord.startsWith("/start@");
}

async function sendWelcomeMessage(chatId, webAppUrl) {
  const normalizedUrl = webAppUrl.replace(/\/?$/, "/");
  const ordersWebAppUrl = `${normalizedUrl}#orders`;

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
        [{ text: "📋 Мої замовлення", web_app: { url: ordersWebAppUrl } }],
      ],
    },
  });
}

function isOrdersCommand(text) {
  const firstWord = text.trim().split(/\s+/)[0];
  return firstWord === "/orders" || firstWord.startsWith("/orders@");
}

async function sendOrdersWebAppButton(chatId, webAppUrl) {
  const normalizedUrl = webAppUrl.replace(/\/?$/, "/");
  const ordersWebAppUrl = `${normalizedUrl}#orders`;

  await sendMessage({
    chat_id: chatId,
    text: "📋 Статус замовлень дивіться у Web App — там stepper і оновлення в реальному часі.",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📋 Відкрити мої замовлення", web_app: { url: ordersWebAppUrl } }],
      ],
    },
  });
}

async function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery.data || "";

  if (data === "orders:list") {
    const webAppUrl = process.env.WEB_APP_URL;
    if (webAppUrl) {
      await sendOrdersWebAppButton(
        callbackQuery.message?.chat?.id || callbackQuery.from.id,
        webAppUrl
      );
    }

    await answerCallbackQuery({
      callback_query_id: callbackQuery.id,
    });
    return;
  }

  const [actionCode, orderId] = data.split(":");

  const actionMap = {
    c: "confirm",
    p: "prepare",
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
    const webAppUrl = process.env.WEB_APP_URL;

    if (typeof text === "string" && isStartCommand(text)) {
      if (!webAppUrl) {
        throw new Error("WEB_APP_URL is not set");
      }

      await sendWelcomeMessage(update.message.chat.id, webAppUrl);
      return res.status(200).send("OK");
    }

    if (typeof text === "string" && isOrdersCommand(text)) {
      if (webAppUrl) {
        await sendOrdersWebAppButton(update.message.chat.id, webAppUrl);
      } else {
        const orders = await getUserOrders(update.message.from.id);
        await sendMessage({
          chat_id: update.message.chat.id,
          text:
            orders.length > 0
              ? "📋 Є активні замовлення. Відкрийте меню через /start."
              : "📋 Активних замовлень немає.",
        });
      }
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

  if (
    path === "/api/order" ||
    path.endsWith("/order") ||
    path === "/api/orders" ||
    path.endsWith("/orders") ||
    path === "/api/cron-prepare" ||
    path.endsWith("/cron-prepare")
  ) {
    req.body = parseBody(req);
    return handleOrderApi(req, res, path);
  }

  try {
    if (typeof req.body === "string") {
      req.body = parseBody(req);
    }
  } catch {
    // ignore
  }

  return handleWebhook(req, res);
};

module.exports.handleWebhook = handleWebhook;
