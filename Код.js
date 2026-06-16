var token = "8966788463:AAENOKPuT64ZNpSFVpV-f3Ft_JCnpz1Nk08";
var webAppUrl = "https://calendarhouses.github.io/azhunebi-menu/";

function doPost(e) {
  try {
    if (e && e.postData && e.postData.contents) {
      handleUpdate(e.postData.contents);
    }
  } catch (error) {
    // Глушимо помилку, щоб не викликати ретрити від Telegram
  }

  return ContentService.createTextOutput("OK")
    .setMimeType(ContentService.MimeType.TEXT);
}

function handleUpdate(contents) {
  var update = JSON.parse(contents);

  if (!update.message || !update.message.text || !isStartCommand(update.message.text)) {
    return;
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) {
    return;
  }

  try {
    if (isUpdateSeen(update.update_id)) {
      return;
    }

    markUpdateSeen(update.update_id);
    queueStartMessage(update.message.chat.id);
  } finally {
    lock.releaseLock();
  }
}

function isStartCommand(text) {
  var firstWord = text.trim().split(/\s+/)[0];
  return firstWord === "/start" || firstWord.indexOf("/start@") === 0;
}

function isUpdateSeen(updateId) {
  return CacheService.getScriptCache().get("upd_" + updateId) === "1";
}

function markUpdateSeen(updateId) {
  CacheService.getScriptCache().put("upd_" + updateId, "1", 86400);
}

function queueStartMessage(chatId) {
  PropertiesService.getScriptProperties().setProperty("pendingChatId", String(chatId));
  deleteTriggersFor("deliverStartMessage");
  ScriptApp.newTrigger("deliverStartMessage").timeBased().after(1000).create();
}

function deliverStartMessage() {
  try {
    var chatId = PropertiesService.getScriptProperties().getProperty("pendingChatId");
    if (chatId) {
      sendWelcomeMessage(chatId);
      PropertiesService.getScriptProperties().deleteProperty("pendingChatId");
    }
  } finally {
    deleteTriggersFor("deliverStartMessage");
  }
}

function sendWelcomeMessage(chatId) {
  UrlFetchApp.fetch(
    "https://api.telegram.org/bot" + token + "/sendMessage",
    {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        chat_id: chatId,
        text: "🌲 Вітаємо в комплексі «Аж у небі»!\n\nНатисніть кнопку нижче, щоб відкрити наше меню та зробити замовлення:",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🍽 Відкрити меню",
                web_app: {
                  url: webAppUrl
                }
              }
            ]
          ]
        }
      }),
      muteHttpExceptions: true
    }
  );
}

// Запустіть setupBot() один раз у редакторі GAS (після деплою Web App).
function setupBot() {
  var webhookUrl = ScriptApp.getService().getUrl();

  UrlFetchApp.fetch(
    "https://api.telegram.org/bot" + token + "/setWebhook",
    {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify({
        url: webhookUrl,
        drop_pending_updates: true,
        allowed_updates: ["message"]
      }),
      muteHttpExceptions: true
    }
  );

  installKeepAlive();
}

function installKeepAlive() {
  deleteTriggersFor("keepAlive");
  ScriptApp.newTrigger("keepAlive").timeBased().everyMinutes(5).create();
}

function keepAlive() {
  CacheService.getScriptCache().put("alive", String(Date.now()), 600);
}

function deleteTriggersFor(handlerName) {
  var triggers = ScriptApp.getProjectTriggers();

  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}
