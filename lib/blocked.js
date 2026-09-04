const { TENANT_ID, getSupabaseAdmin } = require("./supabase");

/** Immediate hard blocks (also seeded in telegram_blocked). */
const HARD_BLOCKED_USERNAMES = new Set(["alisa2013", "jaxxmyyhusband"]);

function normalizeUsername(raw) {
  if (!raw || typeof raw !== "string") {
    return null;
  }

  const normalized = raw.trim().replace(/^@+/, "").toLowerCase();
  return normalized || null;
}

function getEnvBlockedUsernames() {
  const raw = process.env.BLOCKED_TELEGRAM_USERNAMES || "";
  return new Set(
    raw
      .split(",")
      .map((part) => normalizeUsername(part))
      .filter(Boolean)
  );
}

async function isTelegramUserBlocked(user) {
  const username = normalizeUsername(user?.username);
  if (!username) {
    return false;
  }

  if (HARD_BLOCKED_USERNAMES.has(username)) {
    return true;
  }

  if (getEnvBlockedUsernames().has(username)) {
    return true;
  }

  try {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase
      .from("telegram_blocked")
      .select("telegram_username")
      .eq("tenant_id", TENANT_ID)
      .eq("telegram_username", username)
      .maybeSingle();

    if (error) {
      if (error.code !== "42P01" && error.code !== "PGRST205") {
        console.error("[blocked] lookup failed", error.message);
      }
      return false;
    }

    return Boolean(data);
  } catch (error) {
    console.error("[blocked] lookup failed", error?.message || error);
    return false;
  }
}

module.exports = {
  normalizeUsername,
  isTelegramUserBlocked,
  HARD_BLOCKED_USERNAMES,
};
