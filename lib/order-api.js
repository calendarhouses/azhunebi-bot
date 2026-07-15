const { validateInitData } = require("./telegram");
const {
  createOrder,
  notifyAdminNewOrder,
  attachOrderScreenshot,
  getActiveUserOrders,
  getUserOrderById,
  processScheduledOrders,
  processAdminNotifyFallback,
  serializeOrderForApp,
} = require("./orders");

const {
  getRunningTabForUser,
  changeGuestHouse,
  getHouseBindingForUser,
  unbindGuestUser,
  getSessionsDashboard,
  getSessionDetail,
  moveOrderToHouse,
  checkOutSession,
} = require("./sessions");

const API_VERSION = "2026-06-18-v8-running-tab";
const { isValidCabinNumber } = require("./cabins");

function setCorsHeaders(res) {
  const origin =
    process.env.ALLOWED_ORIGIN || "https://calendarhouses.github.io";

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Azhunebi-Action, X-Action"
  );
  res.setHeader("X-Azhunebi-Version", API_VERSION);
}

function parseBody(req) {
  const raw = req.body;

  if (!raw) {
    return {};
  }

  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  if (Buffer.isBuffer(raw)) {
    try {
      return JSON.parse(raw.toString("utf8"));
    } catch {
      return {};
    }
  }

  return raw;
}

function resolveAction(req, body) {
  const query = req.query || {};
  return (
    body.action ||
    query.action ||
    req.headers["x-azhunebi-action"] ||
    req.headers["x-action"] ||
    null
  );
}

function isCronPath(path) {
  return path === "/api/cron-prepare" || path.endsWith("/cron-prepare");
}

function isOrdersPath(path) {
  return path === "/api/orders" || path.endsWith("/orders");
}

function isQueryAction(action) {
  return (
    action === "list" ||
    action === "get" ||
    action === "health" ||
    action === "sync" ||
    action === "getRunningTab" ||
    action === "getHouseBinding" ||
    action === "leaveHouse"
  );
}

async function handleCreateOrder(body) {
  const {
    initData,
    cart,
    comment,
    locationNote,
    tableNumber,
    paymentMethod,
    scheduledFor,
  } = body;
  const user = validateInitData(initData);

  if (!user) {
    const error = new Error("Invalid initData");
    error.statusCode = 401;
    throw error;
  }

  const order = await createOrder({
    user,
    cartInput: cart,
    comment,
    locationNote,
    tableNumber,
    paymentMethod,
    scheduledFor,
  });

  await notifyAdminNewOrder(order);

  return {
    ok: true,
    orderId: order.id,
    order: serializeOrderForApp(order),
  };
}

async function handleAttachScreenshot(body) {
  const { initData, orderId, screenshot } = body;
  const user = validateInitData(initData);

  if (!user) {
    const error = new Error("Invalid initData");
    error.statusCode = 401;
    throw error;
  }

  if (!orderId || !screenshot) {
    const error = new Error("Missing orderId or screenshot");
    error.statusCode = 400;
    throw error;
  }

  await attachOrderScreenshot(user.id, orderId, screenshot);

  return { ok: true };
}

async function handleOrdersQuery(body) {
  const { initData, orderId, action } = body;
  const user = validateInitData(initData);

  if (!user) {
    const error = new Error("Invalid initData");
    error.statusCode = 401;
    throw error;
  }

  if (action === "list") {
    const orders = await getActiveUserOrders(user.id);
    return { ok: true, orders };
  }

  if (action === "sync") {
    const [orders, runningTab] = await Promise.all([
      getActiveUserOrders(user.id),
      getRunningTabForUser(user.id),
    ]);
    return { ok: true, orders, runningTab };
  }

  if (action === "get") {
    if (!orderId) {
      const error = new Error("Missing orderId");
      error.statusCode = 400;
      throw error;
    }

    const order = await getUserOrderById(user.id, orderId);

    if (!order) {
      const error = new Error("Order not found");
      error.statusCode = 404;
      throw error;
    }

    return { ok: true, order };
  }

  if (action === "getRunningTab") {
    const runningTab = await getRunningTabForUser(user.id);
    return { ok: true, runningTab };
  }

  if (action === "getHouseBinding") {
    const binding = await getHouseBindingForUser(user.id);
    return { ok: true, binding };
  }

  if (action === "leaveHouse") {
    await unbindGuestUser(user.id);
    return { ok: true };
  }

  const error = new Error("Unknown action");
  error.statusCode = 400;
  throw error;
}

async function handleCronPrepare(req) {
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret) {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${cronSecret}`) {
      const error = new Error("Unauthorized");
      error.statusCode = 401;
      throw error;
    }
  }

  const scheduled = await processScheduledOrders();
  const adminFallback = await processAdminNotifyFallback();

  return {
    ok: true,
    updated: scheduled.updated,
    adminFallbackUpdated: adminFallback.updated,
  };
}

async function handleOrderApi(req, res, path = "") {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    if (req.method === "GET") {
      return res.status(200).json({
        ok: true,
        service: "azhunebi-order-api",
        version: API_VERSION,
      });
    }

    if (isCronPath(path)) {
      const result = await handleCronPrepare(req);
      return res.status(200).json(result);
    }

    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const body = parseBody(req);
    req.body = body;

    let action = resolveAction(req, body);

    if (isOrdersPath(path) && !action) {
      action = "list";
      body.action = "list";
    }

    if (isQueryAction(action)) {
      const result = await handleOrdersQuery({ ...body, action });
      return res.status(200).json(result);
    }

    if (action === "attachScreenshot") {
      const result = await handleAttachScreenshot(body);
      return res.status(200).json(result);
    }

    if (action === "changeHouse") {
      const user = validateInitData(body.initData);
      if (!user) {
        return res.status(401).json({ ok: false, error: "Invalid initData" });
      }

      const cabinNumber = body.cabinNumber;
      if (cabinNumber == null || !isValidCabinNumber(Number(cabinNumber))) {
        return res
          .status(400)
          .json({ ok: false, error: "Missing or invalid cabinNumber" });
      }

      const runningTab = await changeGuestHouse(user.id, cabinNumber);
      return res.status(200).json({ ok: true, runningTab });
    }

    const result = await handleCreateOrder(body);
    return res.status(200).json(result);
  } catch (error) {
    const statusCode = error.statusCode || 400;
    return res.status(statusCode).json({
      ok: false,
      error: error instanceof Error ? error.message : "Request failed",
      version: API_VERSION,
    });
  }
}

module.exports = {
  API_VERSION,
  setCorsHeaders,
  handleOrderApi,
  parseBody,
  resolveAction,
};
