const fs = require("fs");
const path = require("path");
const { sendStickerByFileId, sendStickerUpload } = require("./telegram");

const STICKERS_DIR = path.join(__dirname, "stickers");

const STICKER_META = {
  hi: { file: "hi.tgs", env: "STICKER_FILE_ID_HI" },
  love: { file: "love.tgs", env: "STICKER_FILE_ID_LOVE" },
};

/** @type {Record<string, Buffer>} */
const tgsBuffers = {};

/** @type {Record<string, string>} */
const fileIdCache = {};

for (const [key, meta] of Object.entries(STICKER_META)) {
  tgsBuffers[key] = fs.readFileSync(path.join(STICKERS_DIR, meta.file));

  const fromEnv = process.env[meta.env];
  if (fromEnv) {
    fileIdCache[key] = fromEnv;
  }
}

function extractStickerFileId(result) {
  return result?.sticker?.file_id || null;
}

async function sendSticker(chatId, key) {
  const cachedId = fileIdCache[key];
  if (cachedId) {
    return sendStickerByFileId({ chat_id: chatId, sticker: cachedId });
  }

  const buffer = tgsBuffers[key];
  if (!buffer) {
    throw new Error(`Unknown sticker key: ${key}`);
  }

  const result = await sendStickerUpload({ chat_id: chatId, tgsBuffer: buffer });
  const fileId = extractStickerFileId(result);

  if (fileId) {
    fileIdCache[key] = fileId;
    console.info(`[stickers] cached file_id for ${key}: ${fileId}`);
  }

  return result;
}

async function sendHiSticker(chatId) {
  return sendSticker(chatId, "hi");
}

async function sendLoveSticker(chatId) {
  return sendSticker(chatId, "love");
}

module.exports = {
  sendHiSticker,
  sendLoveSticker,
};
