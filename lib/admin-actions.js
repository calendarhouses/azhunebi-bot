const { TENANT_ID, getSupabaseAdmin } = require("./supabase");
const {
  isOwnerUser,
  isTelegramAdmin,
  listTelegramAdmins,
  addTelegramAdmin,
  removeTelegramAdmin,
} = require("./admins");

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
      .select("id, name, sort_order")
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

async function handleAdminAction(user, action, payload) {
  switch (action) {
    case "check":
      return checkAdminAccess(user);
    case "load":
      return loadAdminData(user);
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
