const { createClient } = require("@supabase/supabase-js");

const TENANT_ID =
  process.env.TENANT_ID || "3767b167-cc5f-4d4d-ae59-95e8bc6f795b";

function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set");
  }

  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

module.exports = {
  TENANT_ID,
  getSupabaseAdmin,
};
