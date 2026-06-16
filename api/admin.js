const { validateInitData } = require("../lib/telegram");
const { handleAdminAction } = require("../lib/admin-actions");

function setCorsHeaders(res) {
  const origin =
    process.env.ALLOWED_ORIGIN || "https://calendarhouses.github.io";

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

module.exports = async (req, res) => {
  setCorsHeaders(res);

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
