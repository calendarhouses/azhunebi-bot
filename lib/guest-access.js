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
  await revokeGuestMenuAccessForUsers(userIds);
  await revokeGuestMenuAccessForSession(sessionId);
}

async function userCanOrder(user) {
  if (await isTelegramAdmin(user)) {
    return { allowed: true, reason: "admin" };
  }

  const access = await getGuestMenuAccess(user.id);
  if (access) {
    return { allowed: true, reason: "access", access };
  }

  return { allowed: false, reason: "no_access" };
}

/**
 * Grant/refresh access from a QR start_param (cabin or table).
 * Cabin QR also opens/binds the house session.
 */
async function claimGuestAccessFromStartParam(user, startParam) {
  if (await isTelegramAdmin(user)) {
    const parsed = parseAccessStartParam(startParam);
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
        granted_at: new Date().toISOString(),
      });
    } else if (parsed?.type === "table") {
      await upsertGuestMenuAccess({
        telegram_user_id: normalizeTelegramUserId(user.id),
        source: "table",
        cabin_number: null,
        table_number: parsed.number,
        session_id: null,
        granted_at: new Date().toISOString(),
      });
    }

    return {
      allowed: true,
      reason: "admin",
      access: await getGuestMenuAccess(user.id),
      location: parsed,
    };
  }

  const parsed = parseAccessStartParam(startParam);
  if (!parsed) {
    const existing = await getGuestMenuAccess(user.id);
    return {
      allowed: Boolean(existing),
      reason: existing ? "access" : "no_access",
      access: existing,
      location: null,
    };
  }

  if (parsed.type === "cabin") {
    const { getOrCreateActiveSession, bindUserToSession } = require("./sessions");
    const session = await getOrCreateActiveSession(parsed.number);
    await bindUserToSession(user.id, parsed.number, session.id);
    await upsertGuestMenuAccess({
      telegram_user_id: normalizeTelegramUserId(user.id),
      source: "cabin",
      cabin_number: parsed.number,
      table_number: null,
      session_id: session.id,
      granted_at: new Date().toISOString(),
    });
  } else {
    await upsertGuestMenuAccess({
      telegram_user_id: normalizeTelegramUserId(user.id),
      source: "table",
      cabin_number: null,
      table_number: parsed.number,
      session_id: null,
      granted_at: new Date().toISOString(),
    });
  }

  return {
    allowed: true,
    reason: "granted",
    access: await getGuestMenuAccess(user.id),
    location: parsed,
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
  userCanOrder,
  claimGuestAccessFromStartParam,
  grantAccessFromStartPayload,
};
