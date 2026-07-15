const API_VERSION = "2026-07-15-callback-fix";

function getBotToken() {
  return process.env.TELEGRAM_BOT_TOKEN || "";
}

async function fetchWebhookInfo() {
  const token = getBotToken();
  if (!token) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN missing" };
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/getWebhookInfo`
  );
  return response.json();
}

async function ensureWebhook(url) {
  const token = getBotToken();
  if (!token) {
    return { ok: false, error: "TELEGRAM_BOT_TOKEN missing" };
  }

  const response = await fetch(
    `https://api.telegram.org/bot${token}/setWebhook`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        drop_pending_updates: false,
        allowed_updates: ["message", "callback_query"],
      }),
    }
  );

  return response.json();
}

module.exports = async (req, res) => {
  res.setHeader(
    "Access-Control-Allow-Origin",
    process.env.ALLOWED_ORIGIN || "https://calendarhouses.github.io"
  );
  res.setHeader("X-Azhunebi-Version", API_VERSION);

  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || "";
  const query = req.query || {};
  const authorized =
    Boolean(secret) &&
    (authHeader === `Bearer ${secret}` || query.secret === secret);

  if (req.method === "POST" && query.action === "setWebhook") {
    if (!authorized) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const webhookUrl =
      (typeof query.url === "string" && query.url) ||
      process.env.WEBHOOK_URL ||
      "https://azhunebi-bot.vercel.app/api/webhook";

    const result = await ensureWebhook(webhookUrl);
    return res.status(result.ok ? 200 : 500).json({
      ok: Boolean(result.ok),
      service: "azhunebi-bot",
      version: API_VERSION,
      webhookUrl,
      telegram: result,
    });
  }

  if (query.webhook === "1") {
    if (!authorized) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const info = await fetchWebhookInfo();
    return res.status(200).json({
      ok: true,
      service: "azhunebi-bot",
      version: API_VERSION,
      hasBotToken: Boolean(getBotToken()),
      hasAdminChat: Boolean(process.env.ADMIN_TELEGRAM_ID),
      webhook: info.result || info,
    });
  }

  return res.status(200).json({
    ok: true,
    service: "azhunebi-bot",
    version: API_VERSION,
  });
};
