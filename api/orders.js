const { validateInitData } = require("../lib/telegram");
const {
  getActiveUserOrders,
  getUserOrderById,
} = require("../lib/orders");

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
    const { initData, action, orderId } = req.body || {};
    const user = validateInitData(initData);

    if (!user) {
      return res.status(401).json({ ok: false, error: "Invalid initData" });
    }

    if (action === "list") {
      const orders = await getActiveUserOrders(user.id);
      return res.status(200).json({ ok: true, orders });
    }

    if (action === "get") {
      if (!orderId) {
        return res.status(400).json({ ok: false, error: "Missing orderId" });
      }

      const order = await getUserOrderById(user.id, orderId);

      if (!order) {
        return res.status(404).json({ ok: false, error: "Order not found" });
      }

      return res.status(200).json({ ok: true, order });
    }

    return res.status(400).json({ ok: false, error: "Unknown action" });
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : "Request failed",
    });
  }
};
