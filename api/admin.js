const { validateInitData } = require("../lib/telegram");
const { handleAdminAction } = require("../lib/admin-actions");

function setCorsHeaders(res, req) {
  const configured = String(process.env.ALLOWED_ORIGIN || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const allowed = configured.length
    ? configured
    : [
        "https://azhunebi-menu.vercel.app",
        "https://calendarhouses.github.io",
      ];

  const requestOrigin = req?.headers?.origin;
  const origin =
    requestOrigin && allowed.includes(requestOrigin)
      ? requestOrigin
      : allowed[0];

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

module.exports = async (req, res) => {
  setCorsHeaders(res, req);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const { initData, action, ...payload } = req.body || {};
    const user = validateInitData(initData);

    if (!user) {
      return res.status(401).json({ ok: false, error: "Invalid initData" });
    }

    if (!action) {
      return res.status(400).json({ ok: false, error: "Missing action" });
    }

    const result = await handleAdminAction(user, action, payload);
    return res.status(200).json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Admin request failed";
    const status = message === "Forbidden" ? 403 : 400;
    return res.status(status).json({ ok: false, error: message });
  }
};
