const { validateInitData } = require("./telegram");
const {
  createOrder,
  notifyAdminNewOrder,
  getActiveUserOrders,
  getUserOrderById,
  processScheduledOrders,
  serializeOrderForApp,
} = require("./orders");

const API_VERSION = "2026-06-16-v4";

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
  return action === "list" || action === "get" || action === "health";
}

async function handleCreateOrder(body) {
  const { initData, cart, comment, locationNote, paymentMethod, scheduledFor } =
    body;
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

  const result = await processScheduledOrders();
  return { ok: true, ...result };
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
