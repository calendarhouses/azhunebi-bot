const token = process.env.TELEGRAM_BOT_TOKEN;
const webhookUrl = process.env.WEBHOOK_URL;

if (!token || !webhookUrl) {
  console.error("Set TELEGRAM_BOT_TOKEN and WEBHOOK_URL in .env or environment.");
  process.exit(1);
}

const response = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: webhookUrl,
    drop_pending_updates: true,
    allowed_updates: ["message", "callback_query"],
  }),
});

const result = await response.json();
console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  process.exit(1);
}
