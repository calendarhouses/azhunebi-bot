const crypto = require("crypto");

function getBotToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }
  return token;
}

function validateInitData(initData) {
  if (!initData || typeof initData !== "string") {
    return null;
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");

  if (!hash) {
    return null;
  }

  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(getBotToken())
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (calculatedHash !== hash) {
    return null;
  }

  const authDate = Number(params.get("auth_date"));
  const maxAgeSeconds = 60 * 60 * 24;

  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) {
    return null;
  }

  const userRaw = params.get("user");
  if (!userRaw) {
    return null;
  }

  try {
    return JSON.parse(userRaw);
  } catch {
    return null;
  }
}

async function telegramApi(method, payload) {
  const token = getBotToken();
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (!data.ok) {
    throw new Error(`${method} failed: ${JSON.stringify(data)}`);
  }

  return data.result;
}

async function sendMessage(payload) {
  return telegramApi("sendMessage", payload);
}

async function editMessageText(payload) {
  return telegramApi("editMessageText", payload);
}

async function editMessageCaption(payload) {
  return telegramApi("editMessageCaption", payload);
}

async function answerCallbackQuery(payload) {
  return telegramApi("answerCallbackQuery", payload);
}

// Sends a photo from a data URL (e.g. "data:image/jpeg;base64,...").
// Uses multipart/form-data so the raw bytes are uploaded directly.
async function sendPhotoFromDataUrl({ chat_id, dataUrl, caption, reply_markup }) {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl || "");
  if (!match) {
    throw new Error("Invalid image data URL");
  }

  const contentType = match[1];
  const buffer = Buffer.from(match[2], "base64");
  const ext = contentType.includes("png") ? "png" : "jpg";

  const token = getBotToken();
  const form = new FormData();
  form.append("chat_id", String(chat_id));
  if (caption) {
    form.append("caption", caption);
  }
  if (reply_markup) {
    form.append("reply_markup", JSON.stringify(reply_markup));
  }
  form.append(
    "photo",
    new Blob([buffer], { type: contentType }),
    `order.${ext}`
  );

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendPhoto`,
    { method: "POST", body: form }
  );

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`sendPhoto failed: ${JSON.stringify(data)}`);
  }

  return data.result;
}

// Instant send when sticker was uploaded before (tiny JSON payload).
async function sendStickerByFileId({ chat_id, sticker }) {
  return telegramApi("sendSticker", { chat_id, sticker });
}

// First-time upload of a pre-built .tgs buffer (~11 KB).
async function sendStickerUpload({ chat_id, tgsBuffer }) {
  const token = getBotToken();
  const form = new FormData();
  form.append("chat_id", String(chat_id));
  form.append(
    "sticker",
    new Blob([tgsBuffer], { type: "application/gzip" }),
    "sticker.tgs"
  );

  const response = await fetch(
    `https://api.telegram.org/bot${token}/sendSticker`,
    { method: "POST", body: form }
  );

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`sendSticker failed: ${JSON.stringify(data)}`);
  }

  return data.result;
}

module.exports = {
  getBotToken,
  validateInitData,
  sendMessage,
  editMessageText,
  editMessageCaption,
  sendPhotoFromDataUrl,
  sendStickerByFileId,
  sendStickerUpload,
  answerCallbackQuery,
};
