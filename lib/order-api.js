const { validateInitData } = require("./telegram");
const {
  createOrder,
  notifyAdminNewOrder,
  getActiveUserOrders,
  getUserOrderById,
  processScheduledOrders,
  serializeOrderForApp,
} = require("./orders");

function setCorsHeaders(res) {
  const origin =
    process.env.ALLOWED_ORIGIN || "https://calendarhouses.github.io";

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function isCronPath(path) {
  return path === "/api/cron-prepare" || path.endsWith("/cron-prepare");
}

function isOrdersPath(path) {
  return path === "/api/orders" || path.endsWith("/orders");
}

async function handleCreateOrder(req, res) {
  const { initData, cart, comment, locationNote, paymentMethod, scheduledFor } =
    req.body || {};
  const user = validateInitData(initData);

  if (!user) {
    return res.status(401).json({ ok: false, error: "Invalid initData" });
  }

  const order = await createOrder({
    user,
    cartInput: cart,
    comment,
    locationNote,
    paymentMethod,
    scheduledFor,
  });

  await notifyAdminNewOrder(order);

  return res.status(200).json({
    ok: true,
    orderId: order.id,
    order: serializeOrderForApp(order),
  });
}

async function handleOrdersQuery(req, res) {
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
}

async function handleCronPrepare(req, res) {
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
  }

  const result = await processScheduledOrders();
  return res.status(200).json({ ok: true, ...result });
}

async function handleOrderApi(req, res, path = "") {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    if (isCronPath(path)) {
      if (req.method !== "GET" && req.method !== "POST") {
        return res.status(405).json({ ok: false, error: "Method not allowed" });
      }
      return handleCronPrepare(req, res);
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const action = req.body?.action;

    if (action === "list" || action === "get" || isOrdersPath(path)) {
      if (isOrdersPath(path) && !action) {
        req.body = { ...req.body, action: "list" };
      }
      return handleOrdersQuery(req, res);
    }

    return handleCreateOrder(req, res);
  } catch (error) {
    return res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : "Request failed",
    });
  }
}

module.exports = {
  setCorsHeaders,
  handleOrderApi,
  handleCreateOrder,
  handleOrdersQuery,
  handleCronPrepare,
};
