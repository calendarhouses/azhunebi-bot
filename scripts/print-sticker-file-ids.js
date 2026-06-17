/**
 * One-time helper: uploads hi + love stickers and prints file_id env vars.
 * Usage: TELEGRAM_BOT_TOKEN=... ADMIN_TELEGRAM_ID=... node scripts/print-sticker-file-ids.js
 */
const { sendStickerUpload } = require("../lib/telegram");
const fs = require("fs");
const path = require("path");

async function main() {
  const chatId =
    process.argv[2] || process.env.ADMIN_TELEGRAM_ID || process.env.TEST_CHAT_ID;

  if (!chatId) {
    console.error("Pass chat_id arg or set ADMIN_TELEGRAM_ID in .env");
    process.exit(1);
  }

  for (const key of ["hi", "love"]) {
    const buffer = fs.readFileSync(
      path.join(__dirname, "../lib/stickers", `${key}.tgs`)
    );
    const result = await sendStickerUpload({
      chat_id: Number(chatId),
      tgsBuffer: buffer,
    });
    const fileId = result?.sticker?.file_id;
    const envName = key === "hi" ? "STICKER_FILE_ID_HI" : "STICKER_FILE_ID_LOVE";
    console.log(`${envName}=${fileId}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
