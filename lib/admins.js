const { TENANT_ID, getSupabaseAdmin } = require("./supabase");

function normalizeUsername(raw) {
  if (!raw || typeof raw !== "string") {
    return null;
  }

  const normalized = raw.trim().replace(/^@+/, "").toLowerCase();
  return normalized || null;
}

function getOwnerUsernames() {
  const raw =
    process.env.OWNER_TELEGRAM_USERNAMES ||
    process.env.OWNER_TELEGRAM_USERNAME ||
    "";

  return [
    ...new Set(
      raw
        .split(",")
        .map((part) => normalizeUsername(part))
        .filter(Boolean)
    ),
  ];
}

function isOwnerUser(user) {
  const username = normalizeUsername(user.username);
  if (username && getOwnerUsernames().includes(username)) {
    return true;
  }

  const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;
  if (adminTelegramId && String(user.id) === String(adminTelegramId)) {
    return true;
  }

  return false;
}

async function isTelegramAdmin(user) {
  if (isOwnerUser(user)) {
    return true;
  }

  const username = normalizeUsername(user.username);
  if (!username) {
    return false;
  }

  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("telegram_admins")
    .select("telegram_username")
    .eq("tenant_id", TENANT_ID)
    .eq("telegram_username", username)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return Boolean(data);
}

async function listTelegramAdmins() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("telegram_admins")
    .select("telegram_username, created_at")
    .eq("tenant_id", TENANT_ID)
    .order("created_at", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return data || [];
}

async function addTelegramAdmin(usernameInput) {
  const username = normalizeUsername(usernameInput);

  if (!username) {
    throw new Error("Invalid Telegram username");
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("telegram_admins").insert({
    tenant_id: TENANT_ID,
    telegram_username: username,
  });

  if (error) {
    if (error.code === "23505") {
      throw new Error("This username is already an admin");
    }
    throw new Error(error.message);
  }

  return username;
}

async function removeTelegramAdmin(usernameInput) {
  const username = normalizeUsername(usernameInput);

  if (!username) {
    throw new Error("Invalid Telegram username");
  }

  if (getOwnerUsernames().includes(username)) {
    throw new Error("Cannot remove an owner account");
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("telegram_admins")
    .delete()
    .eq("tenant_id", TENANT_ID)
    .eq("telegram_username", username);

  if (error) {
    throw new Error(error.message);
  }
}

module.exports = {
  normalizeUsername,
  getOwnerUsernames,
  isOwnerUser,
  isTelegramAdmin,
  listTelegramAdmins,
  addTelegramAdmin,
  removeTelegramAdmin,
};
