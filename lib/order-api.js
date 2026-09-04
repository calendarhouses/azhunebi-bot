const { validateInitData, getStartParamFromInitData } = require("./telegram");
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
const {
  userCanOrder,
  claimGuestAccessFromStartParam,
  getGuestMenuAccess,
} = require("./guest-access");
const { maybeSendWelcomeAfterGrant } = require("./guest-welcome");
const { isTelegramUserBlocked } = require("./blocked");

const API_VERSION = "2026-09-04-welcome-button";
const { isValidCabinNumber } = require("./cabins");
const NO_ACCESS_MESSAGE =
  "Доступ лише через QR-код будиночка або столика. Відскануйте QR у комплексі.";
const BLOCKED_MESSAGE =
  "Доступ до бота для вашого акаунта обмежено.";

async function resolveStartParam(body) {
  // Client tgWebAppStartParam is often more reliable than initData on Direct Links.
  return (
    body.startParam ||
    getStartParamFromInitData(body.initData) ||
    null
  );
}

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
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Azhunebi-Action, X-Action"
  );
  res.setHeader("Vary", "Origin");
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
    action === "leaveHouse" ||
    action === "checkAccess" ||
    action === "claimAccess" ||
    action === "sendWelcome"
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
    startParam,
  } = body;
  const user = validateInitData(initData);

  if (!user) {
    const error = new Error("Invalid initData");
    error.statusCode = 401;
    throw error;
  }

  await assertNotBlocked(user);

  // Prefer start_param from signed initData (QR startapp), then client field.
  const claim = await claimGuestAccessFromStartParam(
    user,
    await resolveStartParam(body)
  );
  const canOrder = claim.allowed || (await userCanOrder(user)).allowed;

  if (!canOrder) {
    const error = new Error(NO_ACCESS_MESSAGE);
    error.statusCode = 403;
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

  await assertNotBlocked(user);

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

  if (action === "checkAccess") {
    const startParam = await resolveStartParam(body);
    if (startParam) {
      const claim = await claimGuestAccessFromStartParam(user, startParam);
      await maybeSendWelcomeAfterGrant(user, claim);
      return {
        ok: true,
        allowed: claim.allowed,
        reason: claim.reason,
        access: claim.access || null,
        location: claim.location || null,
      };
    }

    const canOrder = await userCanOrder(user);
    if (canOrder.allowed && canOrder.wasNew) {
      await maybeSendWelcomeAfterGrant(user, canOrder);
    }
    return {
      ok: true,
      allowed: canOrder.allowed,
      reason: canOrder.reason,
      access: canOrder.access || (await getGuestMenuAccess(user.id)) || null,
      location: null,
    };
  }

  if (action === "claimAccess") {
    const claim = await claimGuestAccessFromStartParam(
      user,
      await resolveStartParam(body)
    );
    const welcome = await maybeSendWelcomeAfterGrant(user, claim);
    return {
      ok: true,
      allowed: claim.allowed,
      reason: claim.reason,
      access: claim.access || null,
      location: claim.location || null,
      welcomeSent: Boolean(welcome?.sent),
      welcomeReason: welcome?.reason || null,
    };
  }

  if (action === "sendWelcome") {
    const startParam = await resolveStartParam(body);
    const claim = startParam
      ? await claimGuestAccessFromStartParam(user, startParam)
      : await userCanOrder(user);

    if (!claim.allowed) {
      return {
        ok: true,
        allowed: false,
        welcomeSent: false,
        reason: claim.reason || "no_access",
      };
    }

    const welcome = await maybeSendWelcomeAfterGrant(
      user,
      {
        ...claim,
        location: claim.location || (startParam ? { raw: startParam } : null),
        wasNew: true,
      },
      { force: true }
    );

    return {
      ok: true,
      allowed: true,
      welcomeSent: Boolean(welcome?.sent),
      welcomeReason: welcome?.reason || null,
      welcomeError: welcome?.error || null,
    };
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
  setCorsHeaders(res, req);

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

      await assertNotBlocked(user);

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
