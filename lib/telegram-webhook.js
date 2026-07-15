const { telegramApi } = require("./telegram");

const DEFAULT_WEBHOOK_URL = "https://azhunebi-bot.vercel.app/api/webhook";

let ensurePromise = null;

function resolveWebhookUrl() {
  return (
    process.env.WEBHOOK_URL ||
    DEFAULT_WEBHOOK_URL
  ).replace(/\/$/, "");
}

async function getWebhookInfo() {
  return telegramApi("getWebhookInfo", {});
}

async function setBotWebhook(url = resolveWebhookUrl()) {
  return telegramApi("setWebhook", {
    url,
    drop_pending_updates: false,
    allowed_updates: ["message", "callback_query"],
  });
}

/**
 * Re-register webhook if missing, pointing elsewhere, or Telegram reports errors.
 * Cached per cold start so we don't spam setWebhook.
 */
async function ensureBotWebhook(options = {}) {
  const force = Boolean(options.force);

  if (ensurePromise && !force) {
    return ensurePromise;
  }

  ensurePromise = (async () => {
    const expectedUrl = resolveWebhookUrl();
    let info;

    try {
      info = await getWebhookInfo();
    } catch (error) {
      console.error("[webhook-ensure] getWebhookInfo failed", error);
      throw error;
    }

    const currentUrl = (info?.url || "").replace(/\/$/, "");
    const needsUpdate =
      force ||
      !currentUrl ||
      currentUrl !== expectedUrl ||
      Boolean(info?.last_error_message);

    if (!needsUpdate) {
      return {
        ok: true,
        updated: false,
        expectedUrl,
        info,
      };
    }

    console.warn("[webhook-ensure] re-registering webhook", {
      currentUrl: currentUrl || null,
      expectedUrl,
      lastError: info?.last_error_message || null,
      pending: info?.pending_update_count ?? null,
    });

    await setBotWebhook(expectedUrl);
    const refreshed = await getWebhookInfo();

    return {
      ok: true,
      updated: true,
      expectedUrl,
      info: refreshed,
    };
  })().catch((error) => {
    ensurePromise = null;
    throw error;
  });

  return ensurePromise;
}

module.exports = {
  DEFAULT_WEBHOOK_URL,
  resolveWebhookUrl,
  getWebhookInfo,
  setBotWebhook,
  ensureBotWebhook,
};
