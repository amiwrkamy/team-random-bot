const TelegramBot = require("node-telegram-bot-api");

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

let teamsCount = 0;
let players = {};
let teams = [];

bot.onText(/\/start/, (msg) => {
  players = {};
  teams = [];
  teamsCount = 0;

  bot.sendMessage(msg.chat.id, "تعداد تیم‌ها رو انتخاب کن:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "۲ تیم", callback_data: "2" }],
        [{ text: "۳ تیم", callback_data: "3" }],
      ],
    },
  });
});

bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;

  if (!teamsCount) {
    teamsCount = Number(query.data);
    teams = Array.from({ length: teamsCount }, () => []);

    bot.sendMessage(chatId, "برای ورود به تیم شانسی دکمه رو بزن 👇", {
      reply_markup: {
        inline_keyboard: [[{ text: "🎲 ورود به تیم", callback_data: "join" }]],
      },
    });
    return;
  }

  if (query.data === "join") {
    const userId = query.from.id;
    const name = query.from.first_name;

    if (players[userId]) {
      bot.answerCallbackQuery(query.id, {
        text: "❌ قبلاً وارد تیم شدی",
        show_alert: true,
      });
      return;
    }

    const randomTeam = Math.floor(Math.random() * teamsCount);
    teams[randomTeam].push(name);
    players[userId] = randomTeam;

    let text = `✅ ${name} رفت تو تیم ${randomTeam + 1}\n\n`;
    teams.forEach((t, i) => {
      text += `🏷 تیم ${i + 1}: ${t.join("، ") || "-"}\n`;
    });

    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: query.message.reply_markup,
    });
  }
});
