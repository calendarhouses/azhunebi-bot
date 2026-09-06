const { sendMessage, setChatMenuButton, getChatMenuButton } = require("./telegram");
const { sendHiSticker } = require("./stickers");

const WELCOME_TEXT =
  "✨ Вітаємо в комплексі «Аж у небі»!\n\nНатисніть «Меню» зліва внизу або кнопку нижче, щоб відкрити меню та зробити замовлення:";

const ACCESS_CLOSED_TEXT =
  "🧾 Рахунок закрито.\n\nДоступ до меню тимчасово закритий. Щоб знову замовити — відскануйте QR-код у будиночку або за столиком.";

const DEFAULT_WEB_APP_URL = "https://azhunebi-menu.vercel.app/azhunebi-menu";
const MENU_BUTTON_TEXT = "Меню";

/** Avoid duplicate welcome from claimAccess retries / double /start. */
const recentWelcomeByUser = new Map();
const WELCOME_DEBOUNCE_MS = 15_000;

let menuButtonEnsurePromise = null;

function getWebAppUrl() {
  const configured = String(process.env.WEB_APP_URL || "").trim();
  return configured || DEFAULT_WEB_APP_URL;
}

function openMenuInlineKeyboard(buttonText = "🍽 Відкрити меню") {
  const webAppUrl = getWebAppUrl();
  if (!webAppUrl) {
    return undefined;
  }

  return {
    inline_keyboard: [
      [
        {
          text: buttonText,
          web_app: { url: webAppUrl },
        },
      ],
    ],
  };
}

function isCannotDmError(error) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /forbidden|can't initiate|bot was blocked|chat not found|have no rights|user is deactivated|403/i.test(
    message
  );
}

/**
 * Persistent left Telegram button → Mini App.
 * Access is still gated inside the app after QR / until checkout.
 */
async function ensureDefaultWebAppMenuButton({ force = false } = {}) {
  if (menuButtonEnsurePromise && !force) {
    return menuButtonEnsurePromise;
  }

  menuButtonEnsurePromise = (async () => {
    const webAppUrl = getWebAppUrl();
    if (!webAppUrl) {
      return { ok: false, reason: "missing_web_app_url" };
    }

    let current = null;
    try {
      current = await getChatMenuButton({});
    } catch (error) {
      console.error("[menu-button] getChatMenuButton failed", error);
    }

    const alreadySet =
      current?.type === "web_app" &&
      current?.text === MENU_BUTTON_TEXT &&
      (current?.web_app?.url || "") === webAppUrl;

    if (alreadySet && !force) {
      return { ok: true, updated: false, webAppUrl, current };
    }

    await setChatMenuButton({
      menu_button: {
        type: "web_app",
        text: MENU_BUTTON_TEXT,
        web_app: { url: webAppUrl },
      },
    });

    const refreshed = await getChatMenuButton({});
    return {
      ok: true,
      updated: true,
      webAppUrl,
      current: refreshed,
    };
  })().catch((error) => {
    menuButtonEnsurePromise = null;
    throw error;
  });

  return menuButtonEnsurePromise;
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

  try {
    await ensureDefaultWebAppMenuButton();
  } catch (error) {
    console.error("[welcome] ensure menu button failed", error);
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
    reply_markup: openMenuInlineKeyboard(),
  });

  return true;
}

/**
 * After QR grant from Mini App claimAccess / checkAccess / sendWelcome.
 */
async function maybeSendWelcomeAfterGrant(user, claim, { force = false } = {}) {
  if (!claim?.allowed || !user?.id) {
    return { sent: false, reason: "not_allowed", needsBotStart: false };
  }

  const fromQr = Boolean(claim.location);
  if (!force && !claim.wasNew && !fromQr) {
    return { sent: false, reason: "skip", needsBotStart: false };
  }

  const userId = Number(user.id);
  const now = Date.now();
  const last = recentWelcomeByUser.get(userId) || 0;
  if (!force && now - last < WELCOME_DEBOUNCE_MS) {
    return { sent: false, reason: "debounced", needsBotStart: false };
  }
  recentWelcomeByUser.set(userId, now);

  try {
    await sendGuestMenuWelcome(userId, {
      withSticker: Boolean(claim.wasNew) && !force,
    });
    return { sent: true, needsBotStart: false };
  } catch (error) {
    console.error("[access] welcome after grant failed", error);
    recentWelcomeByUser.delete(userId);
    const needsBotStart = isCannotDmError(error);
    return {
      sent: false,
      reason: needsBotStart ? "needs_bot_start" : "send_failed",
      needsBotStart,
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
  MENU_BUTTON_TEXT,
  sendGuestMenuWelcome,
  maybeSendWelcomeAfterGrant,
  notifyGuestsAccessClosed,
  getWebAppUrl,
  openMenuInlineKeyboard,
  ensureDefaultWebAppMenuButton,
};
