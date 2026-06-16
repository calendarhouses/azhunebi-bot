const WELCOME_TEXT =
  "🌲 Вітаємо в комплексі «Аж у небі»!\n\nНатисніть кнопку нижче, щоб відкрити наше меню та зробити замовлення:";

function isStartCommand(text) {
  const firstWord = text.trim().split(/\s+/)[0];
  return firstWord === "/start" || firstWord.startsWith("/start@");
}

async function sendWelcomeMessage(chatId, webAppUrl) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: WELCOME_TEXT,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "🍽 Відкрити меню",
              web_app: { url: webAppUrl },
            },
          ],
        ],
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`sendMessage failed: ${body}`);
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(200).send("OK");
  }

  try {
    const update = req.body;
    const text = update && update.message && update.message.text;

    if (typeof text === "string" && isStartCommand(text)) {
      const webAppUrl = process.env.WEB_APP_URL;
      if (!webAppUrl) {
        throw new Error("WEB_APP_URL is not set");
      }

      await sendWelcomeMessage(update.message.chat.id, webAppUrl);
    }
  } catch (error) {
    // Повертаємо 200, щоб Telegram не спамив ретраями
  }

  return res.status(200).send("OK");
};
