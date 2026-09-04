const {
  sendMessage,
  answerCallbackQuery,
} = require("../lib/telegram");
const { handleOrderApi, parseBody } = require("../lib/order-api");
const {
  handleOrderCallback,
  getUserOrders,
} = require("../lib/orders");
const { ensureBotWebhook } = require("../lib/telegram-webhook");
const {
  parseAccessStartParam,
  grantAccessFromStartPayload,
} = require("../lib/guest-access");
const { sendGuestMenuWelcome } = require("../lib/guest-welcome");
const { isTelegramAdmin, isOwnerUser } = require("../lib/admins");
const { isTelegramUserBlocked } = require("../lib/blocked");

const QR_ONLY_TEXT =
  "🔒 Меню доступне лише через QR-код у будиночку або за столиком.\n\nВідскануйте QR у комплексі «Аж у небі», щоб зробити замовлення.";

const BLOCKED_TEXT =
  "⛔ Доступ до бота для вашого акаунта обмежено. Якщо це помилка — зверніться до адміністрації комплексу.";

/** iOS Telegram may fire /start twice on startapp links — debounce per user. */
const startRequests = new Map();

const START_DEBOUNCE_MS = 2000;

function isStartCommand(text) {
  const firstWord = text.trim().split(/\s+/)[0];
  return firstWord === "/start" || firstWord.startsWith("/start@");
}

function getStartPayload(text) {
  const parts = text.trim().split(/\s+/);
  return parts.length > 1 ? parts[1] : null;
}

async function sendWelcomeMessage(chatId) {
  await sendGuestMenuWelcome(chatId, { withSticker: true });
}

async function sendQrOnlyMessage(chatId) {
  await sendMessage({
    chat_id: chatId,
    text: QR_ONLY_TEXT,
  });
}

async function sendBlockedMessage(chatId) {
  await sendMessage({
    chat_id: chatId,
    text: BLOCKED_TEXT,
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
  let answered = false;

  async function answer(payload = {}) {
    if (answered) {
      return;
    }
    answered = true;
    await answerCallbackQuery({
      callback_query_id: callbackQuery.id,
      ...payload,
    });
  }

  // Stop Telegram spinner immediately — processing can take longer.
  try {
    await answer();
  } catch (error) {
    console.error("[webhook] early answerCallbackQuery failed", error);
  }

  if (data === "orders:list") {
    const webAppUrl = process.env.WEB_APP_URL;
    if (webAppUrl) {
      await sendOrdersWebAppButton(
        callbackQuery.message?.chat?.id || callbackQuery.from.id,
        webAppUrl
      );
    }
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
      console.warn("[webhook] admin message refresh skipped/failed", {
        data,
        statusChanged: result.statusChanged,
        orderId: result.order?.id,
      });
    }

    console.log("[webhook] callback ok", {
      data,
      statusChanged: result.statusChanged,
      messageRefreshed: result.messageRefreshed,
    });
  } catch (error) {
    console.error("[webhook] callback failed", {
      data,
      message: error?.message || String(error),
      error,
    });
    try {
      await answer({
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
    // Heal broken Telegram webhook after Vercel outages / plan limits.
    ensureBotWebhook().catch((error) => {
      console.error("[webhook] ensureBotWebhook failed", error);
    });

    const update = req.body;

    if (update.callback_query) {
      console.log("[webhook] callback_query", {
        data: update.callback_query.data || null,
        from: update.callback_query.from?.id || null,
      });
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

      const from = update.message.from || {};

      if (await isTelegramUserBlocked(from)) {
        await sendBlockedMessage(update.message.chat.id);
        return res.status(200).send("OK");
      }

      const startPayload = getStartPayload(text);
      const parsedQr = parseAccessStartParam(startPayload);
      const isAdmin =
        (await isTelegramAdmin(from)) || isOwnerUser(from);

      if (parsedQr && userId) {
        try {
          await grantAccessFromStartPayload(userId, startPayload);
        } catch (error) {
          console.error("[webhook] grant access from /start failed", error);
          await sendMessage({
            chat_id: update.message.chat.id,
            text:
              "Не вдалося відкрити доступ по QR. Спробуйте відсканувати код ще раз або зверніться до адміністрації.",
          });
          return res.status(200).send("OK");
        }
        await sendWelcomeMessage(update.message.chat.id);
        return res.status(200).send("OK");
      }

      if (isAdmin) {
        await sendWelcomeMessage(update.message.chat.id);
        return res.status(200).send("OK");
      }

      // Guest already on an open house bill — keep access without new QR.
      if (userId) {
        try {
          const { restoreAccessFromActiveBinding } = require("../lib/guest-access");
          const restored = await restoreAccessFromActiveBinding(userId);
          if (restored?.access) {
            await sendWelcomeMessage(update.message.chat.id);
            return res.status(200).send("OK");
          }
        } catch (error) {
          console.error("[webhook] restore active house access failed", error);
        }
      }

      await sendQrOnlyMessage(update.message.chat.id);
      return res.status(200).send("OK");
    }

    if (typeof text === "string" && isOrdersCommand(text)) {
      const from = update.message.from || {};

      if (await isTelegramUserBlocked(from)) {
        await sendBlockedMessage(update.message.chat.id);
        return res.status(200).send("OK");
      }

      const isAdmin =
        (await isTelegramAdmin(from)) || isOwnerUser(from);

      if (!isAdmin) {
        const { getGuestMenuAccess } = require("../lib/guest-access");
        const access = from.id ? await getGuestMenuAccess(from.id) : null;
        if (!access) {
          await sendQrOnlyMessage(update.message.chat.id);
          return res.status(200).send("OK");
        }
      }

      if (webAppUrl) {
        await sendOrdersWebAppButton(update.message.chat.id, webAppUrl);
      } else {
        const orders = await getUserOrders(from.id);
        await sendMessage({
          chat_id: update.message.chat.id,
          text:
            orders.length > 0
              ? "📋 Є активні замовлення. Відкрийте меню через QR-код."
              : "📋 Активних замовлень немає.",
        });
      }
    }
  } catch (error) {
    console.error("[webhook] handleWebhook failed", error);
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
