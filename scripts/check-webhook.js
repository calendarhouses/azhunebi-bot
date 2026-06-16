const token = process.env.TELEGRAM_BOT_TOKEN;

if (!token) {
  console.error("Set TELEGRAM_BOT_TOKEN in environment.");
  process.exit(1);
}

const response = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
const result = await response.json();

console.log(JSON.stringify(result, null, 2));

if (result.ok && result.result?.url) {
  console.log("\nWebhook URL:", result.result.url);
  console.log("Pending updates:", result.result.pending_update_count);
}

if (!result.ok) {
  process.exit(1);
}
