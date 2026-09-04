const { TENANT_ID, getSupabaseAdmin } = require("./supabase");
const { isTelegramAdmin } = require("./admins");
const { isValidCabinNumber } = require("./cabins");

function normalizeTelegramUserId(id) {
  const value = Number(id);
  if (!Number.isFinite(value)) {
    throw new Error("Invalid Telegram user id");
  }
  return value;
}

/** Parses QR /start payload: c0–c12 cabins, t1–t12 tables. */
function parseAccessStartParam(raw) {
  if (!raw || typeof raw !== "string") {
    return null;
  }

  const match = /^([ct])(\d{1,2})$/i.exec(raw.trim());
  if (!match) {
    return null;
  }

  const kind = match[1].toLowerCase();
  const number = Number(match[2]);

  if (kind === "c") {
    if (!isValidCabinNumber(number)) {
      return null;
    }
    return { type: "cabin", number };
  }

  if (!Number.isFinite(number) || number < 1 || number > 12) {
    return null;
  }

  return { type: "table", number };
}

async function getGuestMenuAccess(telegramUserId) {
  const supabase = getSupabaseAdmin();
  const userId = normalizeTelegramUserId(telegramUserId);

  const { data, error } = await supabase
    .from("guest_menu_access")
    .select(
      "telegram_user_id, source, cabin_number, table_number, session_id, granted_at, updated_at"
    )
    .eq("tenant_id", TENANT_ID)
    .eq("telegram_user_id", userId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

async function upsertGuestMenuAccess(row) {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("guest_menu_access").upsert(
    {
      tenant_id: TENANT_ID,
      ...row,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "tenant_id,telegram_user_id" }
  );

  if (error) {
    throw new Error(error.message);
  }
}

async function revokeGuestMenuAccessForUsers(telegramUserIds) {
  const ids = [
    ...new Set(
      (telegramUserIds || [])
        .map((id) => Number(id))
        .filter((id) => Number.isFinite(id))
    ),
  ];

  if (!ids.length) {
    return;
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("guest_menu_access")
    .delete()
    .eq("tenant_id", TENANT_ID)
    .in("telegram_user_id", ids);

  if (error) {
    throw new Error(error.message);
  }
}

async function revokeGuestMenuAccessForSession(sessionId) {
  if (!sessionId) {
    return;
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("guest_menu_access")
    .delete()
    .eq("tenant_id", TENANT_ID)
    .eq("session_id", sessionId);

  if (error) {
    throw new Error(error.message);
  }
}

async function listSessionGuestUserIds(sessionId) {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("house_guest_bindings")
    .select("telegram_user_id")
    .eq("tenant_id", TENANT_ID)
    .eq("session_id", sessionId);

  if (error) {
    throw new Error(error.message);
  }

  return (data || []).map((row) => row.telegram_user_id);
}

/**
 * After house checkout: drop bindings + menu access for everyone on that session.
 */
async function revokeHouseGuestsAccess(sessionId) {
  const userIds = await listSessionGuestUserIds(sessionId);
  const { notifyGuestsAccessClosed } = require("./guest-welcome");
  // Notify while we still know who was on the house — then revoke access.
  await notifyGuestsAccessClosed(userIds);
  await revokeGuestMenuAccessForUsers(userIds);
  await revokeGuestMenuAccessForSession(sessionId);
}

/**
 * Guests already checked into an active house keep access without re-scanning QR.
 * Restores/creates guest_menu_access from house_guest_bindings + active session.
 */
async function restoreAccessFromActiveBinding(telegramUserId) {
  const { reconcileGuestBinding } = require("./sessions");
  const reconciled = await reconcileGuestBinding(telegramUserId);

  if (!reconciled?.session) {
    return null;
  }

  const userId = normalizeTelegramUserId(telegramUserId);
  const existing = await getGuestMenuAccess(userId);
  const cabinNumber = Number(reconciled.session.cabin_number);

  await upsertGuestMenuAccess({
    telegram_user_id: userId,
    source: "cabin",
    cabin_number: cabinNumber,
    table_number: null,
    session_id: reconciled.session.id,
    granted_at: existing?.granted_at || new Date().toISOString(),
  });

  const access = await getGuestMenuAccess(userId);
  return { access, wasNew: !existing };
}

async function userCanOrder(user) {
  if (await isTelegramAdmin(user)) {
    return { allowed: true, reason: "admin" };
  }

  let access = await getGuestMenuAccess(user.id);
  if (access) {
    return { allowed: true, reason: "access", access, wasNew: false };
  }

  const restored = await restoreAccessFromActiveBinding(user.id);
  if (restored?.access) {
    return {
      allowed: true,
      reason: "active_house",
      access: restored.access,
      wasNew: restored.wasNew,
    };
  }

  return { allowed: false, reason: "no_access", wasNew: false };
}

/**
 * Grant/refresh access from a QR start_param (cabin or table).
 * Cabin QR also opens/binds the house session.
 */
async function claimGuestAccessFromStartParam(user, startParam) {
  if (await isTelegramAdmin(user)) {
    const parsed = parseAccessStartParam(startParam);
    const existing = await getGuestMenuAccess(user.id);
    if (parsed?.type === "cabin") {
      const { getOrCreateActiveSession, bindUserToSession } = require("./sessions");
      const session = await getOrCreateActiveSession(parsed.number);
      await bindUserToSession(user.id, parsed.number, session.id);
      await upsertGuestMenuAccess({
        telegram_user_id: normalizeTelegramUserId(user.id),
        source: "cabin",
        cabin_number: parsed.number,
        table_number: null,
        session_id: session.id,
        granted_at: existing?.granted_at || new Date().toISOString(),
      });
    } else if (parsed?.type === "table") {
      await upsertGuestMenuAccess({
        telegram_user_id: normalizeTelegramUserId(user.id),
        source: "table",
        cabin_number: null,
        table_number: parsed.number,
        session_id: null,
        granted_at: existing?.granted_at || new Date().toISOString(),
      });
    }

    return {
      allowed: true,
      reason: "admin",
      access: await getGuestMenuAccess(user.id),
      location: parsed || null,
      wasNew: !existing,
    };
  }

  const parsed = parseAccessStartParam(startParam);
  if (!parsed) {
    const canOrder = await userCanOrder(user);
    return {
      allowed: canOrder.allowed,
      reason: canOrder.reason,
      access: canOrder.access || (await getGuestMenuAccess(user.id)),
      location: null,
      wasNew: Boolean(canOrder.wasNew),
    };
  }

  const userId = normalizeTelegramUserId(user.id);
  const existing = await getGuestMenuAccess(userId);

  if (parsed.type === "cabin") {
    const { getOrCreateActiveSession, bindUserToSession } = require("./sessions");
    const session = await getOrCreateActiveSession(parsed.number);
    await bindUserToSession(user.id, parsed.number, session.id);
    await upsertGuestMenuAccess({
      telegram_user_id: userId,
      source: "cabin",
      cabin_number: parsed.number,
      table_number: null,
      session_id: session.id,
      granted_at: existing?.granted_at || new Date().toISOString(),
    });
  } else {
    await upsertGuestMenuAccess({
      telegram_user_id: userId,
      source: "table",
      cabin_number: null,
      table_number: parsed.number,
      session_id: null,
      granted_at: existing?.granted_at || new Date().toISOString(),
    });
  }

  return {
    allowed: true,
    reason: "granted",
    access: await getGuestMenuAccess(user.id),
    location: parsed,
    wasNew: !existing,
  };
}

async function grantAccessFromStartPayload(telegramUserId, startPayload) {
  const parsed = parseAccessStartParam(startPayload);
  if (!parsed) {
    return null;
  }

  const userId = normalizeTelegramUserId(telegramUserId);

  if (parsed.type === "cabin") {
    const { getOrCreateActiveSession, bindUserToSession } = require("./sessions");
    const session = await getOrCreateActiveSession(parsed.number);
    await bindUserToSession(userId, parsed.number, session.id);
    await upsertGuestMenuAccess({
      telegram_user_id: userId,
      source: "cabin",
      cabin_number: parsed.number,
      table_number: null,
      session_id: session.id,
      granted_at: new Date().toISOString(),
    });
  } else {
    await upsertGuestMenuAccess({
      telegram_user_id: userId,
      source: "table",
      cabin_number: null,
      table_number: parsed.number,
      session_id: null,
      granted_at: new Date().toISOString(),
    });
  }

  return parsed;
}

module.exports = {
  parseAccessStartParam,
  getGuestMenuAccess,
  upsertGuestMenuAccess,
  revokeGuestMenuAccessForUsers,
  revokeGuestMenuAccessForSession,
  revokeHouseGuestsAccess,
  listSessionGuestUserIds,
  restoreAccessFromActiveBinding,
  userCanOrder,
  claimGuestAccessFromStartParam,
  grantAccessFromStartPayload,
};
