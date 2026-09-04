const { sendMessage } = require("./telegram");
const { sendHiSticker } = require("./stickers");

const WELCOME_TEXT =
  "✨ Вітаємо в комплексі «Аж у небі»!\n\nНатисніть кнопку нижче, щоб знову відкрити меню та зробити замовлення:";

const ACCESS_CLOSED_TEXT =
  "🧾 Рахунок закрито.\n\nДоступ до меню тимчасово закритий. Щоб знову замовити — відскануйте QR-код у будиночку або за столиком.";

const DEFAULT_WEB_APP_URL = "https://azhunebi-menu.vercel.app/azhunebi-menu";

/** Avoid duplicate welcome from claimAccess retries / double /start. */
const recentWelcomeByUser = new Map();
const WELCOME_DEBOUNCE_MS = 15_000;

function getWebAppUrl() {
  const configured = String(process.env.WEB_APP_URL || "").trim();
  return configured || DEFAULT_WEB_APP_URL;
}

async function sendGuestMenuWelcome(chatId, { withSticker = false } = {}) {
  const webAppUrl = getWebAppUrl();
  if (!webAppUrl || !chatId) {
    console.error("[welcome] missing webAppUrl or chatId", {
      webAppUrl: Boolean(webAppUrl),
      chatId,
    });
    return false;
  }

  if (withSticker) {
    try {
      await sendHiSticker(chatId);
    } catch (error) {
      console.error("[welcome] sticker failed", error);
    }
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

  return true;
}

/**
 * After QR grant from Mini App claimAccess / checkAccess / sendWelcome.
 */
async function maybeSendWelcomeAfterGrant(user, claim, { force = false } = {}) {
  if (!claim?.allowed || !user?.id) {
    return { sent: false, reason: "not_allowed" };
  }

  const fromQr = Boolean(claim.location);
  if (!force && !claim.wasNew && !fromQr) {
    return { sent: false, reason: "skip" };
  }

  const userId = Number(user.id);
  const now = Date.now();
  const last = recentWelcomeByUser.get(userId) || 0;
  if (!force && now - last < WELCOME_DEBOUNCE_MS) {
    return { sent: false, reason: "debounced" };
  }
  recentWelcomeByUser.set(userId, now);

  try {
    await sendGuestMenuWelcome(userId, {
      withSticker: Boolean(claim.wasNew) && !force,
    });
    return { sent: true };
  } catch (error) {
    console.error("[access] welcome after grant failed", error);
    recentWelcomeByUser.delete(userId);
    return {
      sent: false,
      reason: "send_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function notifyGuestsAccessClosed(telegramUserIds) {
  const ids = [
    ...new Set(
      (telegramUserIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id))
    ),
  ];

  for (const chatId of ids) {
    try {
      await sendMessage({
        chat_id: chatId,
        text: ACCESS_CLOSED_TEXT,
      });
    } catch (error) {
      console.error("[access] checkout notice failed", { chatId, error });
    }
  }
}

module.exports = {
  WELCOME_TEXT,
  ACCESS_CLOSED_TEXT,
  sendGuestMenuWelcome,
  maybeSendWelcomeAfterGrant,
  notifyGuestsAccessClosed,
  getWebAppUrl,
};
