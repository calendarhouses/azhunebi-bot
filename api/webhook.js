const {
  validateInitData,
  sendMessage,
  answerCallbackQuery,
} = require("../lib/telegram");
const { handleOrderApi, parseBody } = require("../lib/order-api");
const {
  handleOrderCallback,
  getUserOrders,
} = require("../lib/orders");
const { sendHiSticker } = require("../lib/stickers");

const WELCOME_TEXT =
  "✨ Вітаємо в комплексі «Аж у небі»!\n\nНатисніть кнопку нижче, щоб відкрити меню та зробити замовлення:";

/** iOS Telegram may fire /start twice on startapp links — debounce per user. */
const startRequests = new Map();

const START_DEBOUNCE_MS = 2000;

function isStartCommand(text) {
  const firstWord = text.trim().split(/\s+/)[0];
  return firstWord === "/start" || firstWord.startsWith("/start@");
}

async function sendWelcomeMessage(chatId, webAppUrl) {
  try {
    await sendHiSticker(chatId);
  } catch (error) {
    console.error("[welcome] sticker failed", error);
  }

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

  let action = null;
  let orderId = null;

  const prefixActions = {
    accept_: "confirm",
    cancel_: "cancel",
    prepare_: "prepare",
    ready_: "ready",
  };

  for (const [prefix, mappedAction] of Object.entries(prefixActions)) {
    if (data.startsWith(prefix)) {
      action = mappedAction;
      orderId = data.slice(prefix.length);
      break;
    }
  }

  // Legacy short codes (c:, x:, p:, r:) — keep for older messages still in chat.
  if (!action) {
    const [actionCode, legacyId] = data.split(":");
    const legacyMap = {
      c: "confirm",
      p: "prepare",
      x: "cancel",
      r: "ready",
    };
    action = legacyMap[actionCode];
    orderId = legacyId;
  }

  try {
    if (!action || !orderId) {
      throw new Error("Invalid callback");
    }

    const messageContext = callbackQuery.message
      ? {
          chatId: callbackQuery.message.chat.id,
          messageId: callbackQuery.message.message_id,
        }
      : null;

    const result = await handleOrderCallback(action, orderId, messageContext);

    if (!result.messageRefreshed) {
      // Status may already be updated; don't fail the whole tap for UI refresh.
      console.warn("[webhook] admin message refresh skipped/failed", {
        data,
        statusChanged: result.statusChanged,
        orderId: result.order?.id,
      });
    }

    await answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      text: result.statusChanged ? "Оновлено" : "Замовлення вже оброблено",
    });
  } catch (error) {
    console.error("[webhook] callback failed", {
      data,
      message: error?.message || String(error),
      error,
    });
    try {
      await answerCallbackQuery({
        callback_query_id: callbackQuery.id,
        text: "Помилка обробки",
        show_alert: true,
      });
    } catch (answerError) {
      console.error("[webhook] answerCallbackQuery failed", answerError);
    }
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
      const userId = update.message.from?.id;
      if (userId) {
        const now = Date.now();
        const lastRequest = startRequests.get(userId) || 0;

        if (now - lastRequest < START_DEBOUNCE_MS) {
          return res.status(200).send("OK");
        }

        startRequests.set(userId, now);
      }

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

  req.body = parseBody(req);
  return handleWebhook(req, res);
};

module.exports.handleWebhook = handleWebhook;
