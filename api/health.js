const { ensureBotWebhook, getWebhookInfo, resolveWebhookUrl } = require("../lib/telegram-webhook");
const { ensureDefaultWebAppMenuButton } = require("../lib/guest-welcome");

const API_VERSION = "2026-09-06-menu-button";

module.exports = async (req, res) => {
  const force =
    req.method === "POST" ||
    req.query?.repair === "1" ||
    req.query?.force === "1";

  let webhook = null;
  try {
    if (force) {
      webhook = await ensureBotWebhook({ force: true });
    } else {
      const info = await getWebhookInfo();
      const expectedUrl = resolveWebhookUrl();
      const currentUrl = (info?.url || "").replace(/\/$/, "");
      webhook = {
        ok: true,
        updated: false,
        expectedUrl,
        currentUrl,
        matches: currentUrl === expectedUrl,
        pending: info?.pending_update_count ?? null,
        lastError: info?.last_error_message || null,
      };

      if (!webhook.matches || webhook.lastError) {
        webhook = await ensureBotWebhook({ force: true });
      }
    }
  } catch (error) {
    webhook = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      expectedUrl: resolveWebhookUrl(),
    };
  }

  let menuButton = null;
  try {
    menuButton = await ensureDefaultWebAppMenuButton({ force });
  } catch (error) {
    menuButton = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok: true,
    service: "azhunebi-bot",
    version: API_VERSION,
    webhook,
    menuButton,
  });
};
