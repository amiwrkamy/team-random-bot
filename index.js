const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

const TOKEN = process.env.BOT_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

// ---------- Web server (برای Render) ----------
const app = express();
app.get("/", (req, res) => res.send("Bot is running"));
app.listen(process.env.PORT || 3000);

// ---------- حافظه ----------
let users = []; // { id, name }
let teamsCount = 2;

// ---------- ابزار ----------
function getName(user, textName = null) {
  if (user.username) return "@" + user.username;
  if (textName) return textName;
  return user.first_name || "بازیکن";
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

// ---------- /start ----------
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🏟 تیم‌چینی کجا انجام بشه؟",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "👤 داخل ربات", callback_data: "IN_BOT" }],
          [{ text: "👥 داخل گروه", callback_data: "IN_GROUP" }]
        ]
      }
    }
  );
});

// ---------- دکمه‌ها ----------
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const data = q.data;
  const user = q.from;

  // داخل ربات
  if (data === "IN_BOT") {
    bot.sendMessage(chatId, "✍️ اسم بازیکن‌ها رو با فاصله بفرست");
    bot.once("message", (m) => {
      const names = m.text.split(" ").filter(Boolean);
      shuffle(names);

      const teams = Array.from({ length: teamsCount }, () => []);
      names.forEach((n, i) => teams[i % teamsCount].push(n));

      let text = "🎲 نتیجه تیم‌بندی:\n\n";
      teams.forEach((t, i) => {
        text += `🏆 تیم ${i + 1}:\n`;
        t.forEach(p => text += `⚽ ${p}\n`);
        text += "\n";
      });

      bot.sendMessage(chatId, text);
    });
  }

  // داخل گروه (لینک ارسال)
  if (data === "IN_GROUP") {
    const link = `https://t.me/${bot.username}?startgroup=teamchin`;
    bot.sendMessage(
      chatId,
      `👥 روی لینک بزن و ربات رو به گروه بفرست:\n${link}`
    );
  }

  // انتخاب تعداد تیم
  if (data === "TEAM_2" || data === "TEAM_3") {
    teamsCount = data === "TEAM_2" ? 2 : 3;
    users = [];

    bot.editMessageText(
      "🏆 تیم‌چینی شروع شد!\nنقش خودتو انتخاب کن 👇",
      {
        chat_id: chatId,
        message_id: q.message.message_id,
        reply_markup: {
          inline_keyboard: [
            [{ text: "⚽ بازیکن", callback_data: "JOIN" }],
            [{ text: "🔄 قاطی‌کردن دوباره", callback_data: "RESHUFFLE" }]
          ]
        }
      }
    );
  }

  // ثبت‌نام
  if (data === "JOIN") {
    if (users.find(u => u.id === user.id)) return;

    users.push({ id: user.id, name: getName(user) });
    updateTeams(chatId, q.message.message_id);
  }

  // قاطی دوباره (ادمین)
  if (data === "RESHUFFLE") {
    const admins = await bot.getChatAdministrators(chatId);
    if (!admins.find(a => a.user.id === user.id)) return;

    updateTeams(chatId, q.message.message_id, true);
  }

  bot.answerCallbackQuery(q.id);
});

// ---------- پیام ورود ربات به گروه ----------
bot.on("message", (msg) => {
  if (msg.new_chat_members) {
    bot.sendMessage(
      msg.chat.id,
      "🧮 چند تیم می‌خوای؟",
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔵 ۲ تیم", callback_data: "TEAM_2" }],
            [{ text: "🟢 ۳ تیم", callback_data: "TEAM_3" }]
          ]
        }
      }
    );
  }
});

// ---------- ساخت تیم ----------
function updateTeams(chatId, messageId, reshuffle = false) {
  let list = [...users];
  shuffle(list);

  const teams = Array.from({ length: teamsCount }, () => []);
  list.forEach((u, i) => teams[i % teamsCount].push(u.name));

  let text = "🎲 تیم‌ها (لایو):\n\n";
  teams.forEach((t, i) => {
    text += `🏆 تیم ${i + 1}:\n`;
    t.forEach(p => text += `⚽ ${p}\n`);
    text += "\n";
  });

  bot.editMessageText(text, {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: {
      inline_keyboard: [
        [{ text: "⚽ بازیکن", callback_data: "JOIN" }],
        [{ text: "🔄 قاطی‌کردن دوباره", callback_data: "RESHUFFLE" }]
      ]
    }
  });
}
