const API_VERSION = "2026-07-15-webhook-repair";
const { ensureBotWebhook, getWebhookInfo, resolveWebhookUrl } = require("../lib/telegram-webhook");

module.exports = async (req, res) => {
  res.setHeader(
    "Access-Control-Allow-Origin",
    process.env.ALLOWED_ORIGIN || "https://calendarhouses.github.io"
  );
  res.setHeader("X-Azhunebi-Version", API_VERSION);

  const query = req.query || {};
  const repair = query.repair === "1" || query.action === "setWebhook";

  try {
    if (repair) {
      const result = await ensureBotWebhook({ force: true });
      return res.status(200).json({
        ok: true,
        service: "azhunebi-bot",
        version: API_VERSION,
        repair: result,
      });
    }

    if (query.webhook === "1") {
      const info = await getWebhookInfo();
      return res.status(200).json({
        ok: true,
        service: "azhunebi-bot",
        version: API_VERSION,
        expectedUrl: resolveWebhookUrl(),
        webhook: {
          url: info.url || null,
          pendingUpdateCount: info.pending_update_count ?? 0,
          lastErrorDate: info.last_error_date || null,
          lastErrorMessage: info.last_error_message || null,
          maxConnections: info.max_connections ?? null,
          allowedUpdates: info.allowed_updates || null,
        },
      });
    }
  } catch (error) {
    return res.status(500).json({
      ok: false,
      service: "azhunebi-bot",
      version: API_VERSION,
      error: error?.message || String(error),
    });
  }

  return res.status(200).json({
    ok: true,
    service: "azhunebi-bot",
    version: API_VERSION,
  });
};
