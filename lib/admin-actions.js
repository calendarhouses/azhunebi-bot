const { TENANT_ID, getSupabaseAdmin } = require("./supabase");
const {
  isOwnerUser,
  isTelegramAdmin,
  listTelegramAdmins,
  addTelegramAdmin,
  removeTelegramAdmin,
} = require("./admins");
const {
  getSessionsDashboard,
  getSessionDetail,
  moveOrderToHouse,
  checkOutSession,
  getClosedSessionsArchive,
  deleteClosedSession,
} = require("./sessions");
const { handleOrderCallback } = require("./orders");

async function assertAdmin(user) {
  const allowed = await isTelegramAdmin(user);

  if (!allowed) {
    throw new Error("Forbidden");
  }

  return {
    canManageAdmins: isOwnerUser(user),
    username: user.username || null,
  };
}

async function loadAdminData(user) {
  const access = await assertAdmin(user);
  const supabase = getSupabaseAdmin();

  const [dishesResult, categoriesResult, settingsResult] = await Promise.all([
    supabase
      .from("menu_items")
      .select("*")
      .eq("tenant_id", TENANT_ID)
      .order("created_at", { ascending: false }),
    supabase
      .from("categories")
      .select("id, name, sort_order, is_active")
      .eq("tenant_id", TENANT_ID)
      .order("sort_order", { ascending: true }),
    supabase
      .from("tenant_settings")
      .select("tenant_id")
      .eq("tenant_id", TENANT_ID)
      .maybeSingle(),
  ]);

  if (dishesResult.error) {
    throw new Error(dishesResult.error.message);
  }

  if (categoriesResult.error) {
    throw new Error(categoriesResult.error.message);
  }

  if (settingsResult.error) {
    throw new Error(settingsResult.error.message);
  }

  const payload = {
    ok: true,
    dishes: dishesResult.data || [],
    categories: categoriesResult.data || [],
    settings: settingsResult.data || null,
    canManageAdmins: access.canManageAdmins,
    username: access.username,
  };

  if (access.canManageAdmins) {
    payload.admins = await listTelegramAdmins();
  }

  return payload;
}

async function saveDish(user, payload) {
  await assertAdmin(user);
  const supabase = getSupabaseAdmin();

  const row = {
    tenant_id: TENANT_ID,
    name: String(payload.name || "").trim(),
    price: Number(payload.price),
    category: payload.category ? String(payload.category).trim() : null,
    description: payload.description ? String(payload.description).trim() : null,
    image_url: payload.image_url ? String(payload.image_url).trim() : null,
    allergens: payload.allergens ? String(payload.allergens).trim() : null,
    weight_g: payload.weight_g ? Number(payload.weight_g) : null,
    is_available: payload.is_available !== false,
  };

  if (!row.name || Number.isNaN(row.price)) {
    throw new Error("Invalid dish payload");
  }

  if (payload.id) {
    const { error } = await supabase
      .from("menu_items")
      .update(row)
      .eq("id", payload.id)
      .eq("tenant_id", TENANT_ID);

    if (error) {
      throw new Error(error.message);
    }

    return { ok: true, id: payload.id };
  }

  const { data, error } = await supabase
    .from("menu_items")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return { ok: true, id: data.id };
}

async function deleteDish(user, id) {
  await assertAdmin(user);
  const supabase = getSupabaseAdmin();

  const { error } = await supabase
    .from("menu_items")
    .delete()
    .eq("id", id)
    .eq("tenant_id", TENANT_ID);

  if (error) {
    throw new Error(error.message);
  }

  return { ok: true };
}

async function saveCategory(user, payload) {
  await assertAdmin(user);
  const supabase = getSupabaseAdmin();

  const name = String(payload.name || "").trim();
  if (!name) {
    throw new Error("Category name is required");
  }

  const row = {
    name,
    sort_order: Number(payload.sort_order) || 0,
    is_active: payload.is_active !== false,
  };

  if (payload.id) {
    const { error } = await supabase
      .from("categories")
      .update(row)
      .eq("id", payload.id)
      .eq("tenant_id", TENANT_ID);

    if (error) {
      throw new Error(error.message);
    }

    return { ok: true, id: payload.id };
  }

  const { data, error } = await supabase
    .from("categories")
    .insert({ tenant_id: TENANT_ID, ...row })
    .select("id")
    .single();

  if (error) {
    throw new Error(error.message);
  }

  return { ok: true, id: data.id };
}

async function deleteCategory(user, id) {
  await assertAdmin(user);
  const supabase = getSupabaseAdmin();

  const { error } = await supabase
    .from("categories")
    .delete()
    .eq("id", id)
    .eq("tenant_id", TENANT_ID);

  if (error) {
    throw new Error(error.message);
  }

  return { ok: true };
}

async function updateLogo(user, payload) {
  await assertAdmin(user);

  const fileBase64 = payload.fileBase64;
  const contentType = payload.contentType || "image/png";

  if (!fileBase64 || typeof fileBase64 !== "string") {
    throw new Error("Missing file data");
  }

  const buffer = Buffer.from(fileBase64, "base64");
  const extension = String(payload.fileName || "logo.png")
    .split(".")
    .pop()
    .toLowerCase();
  const path = `${TENANT_ID}/logo-${Date.now()}.${extension || "png"}`;
  const supabase = getSupabaseAdmin();

  const { error: uploadError } = await supabase.storage
    .from("brand-assets")
    .upload(path, buffer, {
      upsert: true,
      contentType,
    });

  if (uploadError) {
    throw new Error(uploadError.message);
  }

  const { data: publicData } = supabase.storage
    .from("brand-assets")
    .getPublicUrl(path);

  const { error: updateError } = await supabase
    .from("tenant_settings")
    .update({
      logo_url: publicData.publicUrl,
      updated_at: new Date().toISOString(),
    })
    .eq("tenant_id", TENANT_ID);

  if (updateError) {
    throw new Error(updateError.message);
  }

  return { ok: true, logoUrl: publicData.publicUrl };
}

async function addAdmin(user, username) {
  if (!isOwnerUser(user)) {
    throw new Error("Only the owner can manage admins");
  }

  const created = await addTelegramAdmin(username);
  return { ok: true, username: created };
}

async function removeAdmin(user, username) {
  if (!isOwnerUser(user)) {
    throw new Error("Only the owner can manage admins");
  }

  await removeTelegramAdmin(username);
  return { ok: true };
}

async function checkAdminAccess(user) {
  const allowed = await isTelegramAdmin(user);

  return {
    ok: true,
    isAdmin: allowed,
    canManageAdmins: allowed ? isOwnerUser(user) : false,
    username: user.username || null,
  };
}

async function loadSessionsDashboard(user) {
  await assertAdmin(user);
  const cabins = await getSessionsDashboard();
  return { ok: true, cabins };
}

async function loadSessionDetail(user, sessionId) {
  await assertAdmin(user);

  if (!sessionId) {
    throw new Error("Missing sessionId");
  }

  const detail = await getSessionDetail(sessionId);
  return { ok: true, ...detail };
}

async function adminMoveOrder(user, payload) {
  await assertAdmin(user);

  if (!payload.orderId || !payload.cabinNumber) {
    throw new Error("Missing orderId or cabinNumber");
  }

  await moveOrderToHouse(payload.orderId, payload.cabinNumber);

  if (!payload.sessionId) {
    throw new Error("Missing sessionId");
  }

  const detail = await getSessionDetail(payload.sessionId);
  return { ok: true, ...detail };
}

async function adminCheckOut(user, payload) {
  await assertAdmin(user);

  if (!payload.sessionId) {
    throw new Error("Missing sessionId");
  }

  const result = await checkOutSession(
    payload.sessionId,
    user.username || user.first_name || "admin"
  );

  return { ok: true, ...result };
}

async function loadClosedSessionsArchive(user) {
  await assertAdmin(user);
  const sessions = await getClosedSessionsArchive();
  return { ok: true, sessions };
}

async function adminCancelOrder(user, payload) {
  await assertAdmin(user);

  if (!payload.orderId) {
    throw new Error("Missing orderId");
  }

  // Same path as Telegram inline "Скасувати" — guest notify + admin message refresh.
  await handleOrderCallback("cancel", payload.orderId);

  if (!payload.sessionId) {
    return { ok: true };
  }

  const detail = await getSessionDetail(payload.sessionId);
  return { ok: true, ...detail };
}

async function adminDeleteClosedSession(user, payload) {
  await assertAdmin(user);

  if (!payload.sessionId) {
    throw new Error("Missing sessionId");
  }

  const result = await deleteClosedSession(payload.sessionId);
  return { ok: true, ...result };
}

async function handleAdminAction(user, action, payload) {
  switch (action) {
    case "check":
      return checkAdminAccess(user);
    case "load":
      return loadAdminData(user);
    case "loadSessionsDashboard":
      return loadSessionsDashboard(user);
    case "loadSessionDetail":
      return loadSessionDetail(user, payload.sessionId);
    case "loadClosedSessionsArchive":
      return loadClosedSessionsArchive(user);
    case "moveOrderToHouse":
      return adminMoveOrder(user, payload);
    case "checkOutSession":
      return adminCheckOut(user, payload);
    case "cancelOrder":
      return adminCancelOrder(user, payload);
    case "deleteClosedSession":
      return adminDeleteClosedSession(user, payload);
    case "saveDish":
      return saveDish(user, payload);
    case "deleteDish":
      return deleteDish(user, payload.id);
    case "saveCategory":
      return saveCategory(user, payload);
    case "deleteCategory":
      return deleteCategory(user, payload.id);
    case "updateLogo":
      return updateLogo(user, payload);
    case "addAdmin":
      return addAdmin(user, payload.username);
    case "removeAdmin":
      return removeAdmin(user, payload.username);
    default:
      throw new Error("Unknown action");
  }
}

module.exports = {
  handleAdminAction,
  checkAdminAccess,
};
