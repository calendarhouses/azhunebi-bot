const { sendMessage } = require("./telegram");
const { sendHiSticker } = require("./stickers");

const WELCOME_TEXT =
  "✨ Вітаємо в комплексі «Аж у небі»!\n\nНатисніть кнопку нижче, щоб відкрити меню та зробити замовлення:";

const ACCESS_CLOSED_TEXT =
  "🧾 Рахунок закрито.\n\nДоступ до меню тимчасово закритий. Щоб знову замовити — відскануйте QR-код у будиночку або за столиком.";

/** Avoid duplicate welcome from claimAccess retries / double /start. */
const recentWelcomeByUser = new Map();
const WELCOME_DEBOUNCE_MS = 90_000;

function getWebAppUrl() {
  return process.env.WEB_APP_URL || null;
}

async function sendGuestMenuWelcome(chatId, { withSticker = true } = {}) {
  const webAppUrl = getWebAppUrl();
  if (!webAppUrl || !chatId) {
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
 * After QR grant from Mini App claimAccess / checkAccess.
 * Sends whenever access is new or claimed via cabin/table QR (debounced).
 */
async function maybeSendWelcomeAfterGrant(user, claim) {
  if (!claim?.allowed || !user?.id) {
    return;
  }

  const fromQr = Boolean(claim.location);
  if (!claim.wasNew && !fromQr) {
    return;
  }

  const userId = Number(user.id);
  const now = Date.now();
  const last = recentWelcomeByUser.get(userId) || 0;
  if (now - last < WELCOME_DEBOUNCE_MS) {
    return;
  }
  recentWelcomeByUser.set(userId, now);

  try {
    // Mini App claim: skip sticker to keep the chat button fast and reliable.
    await sendGuestMenuWelcome(userId, { withSticker: Boolean(claim.wasNew) });
  } catch (error) {
    console.error("[access] welcome after grant failed", error);
    recentWelcomeByUser.delete(userId);
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
};
