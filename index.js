const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

const TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID);
const BASE_URL = process.env.BASE_URL;

const bot = new TelegramBot(TOKEN);
const app = express();
app.use(express.json());

bot.setWebHook(`${BASE_URL}/bot${TOKEN}`);

app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("Bot is running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started"));

/* ================== LOGIC ================== */

let games = {}; // chatId => game data

function shuffle(array) {
  return array.sort(() => Math.random() - 0.5);
}

function buildTeams(players) {
  const shuffled = shuffle([...players]);

  const teamA = [];
  const teamB = [];
  const subsA = [];
  const subsB = [];

  shuffled.forEach((p, i) => {
    if (i % 2 === 0) {
      teamA.length < 5 ? teamA.push(p) : subsA.push(p);
    } else {
      teamB.length < 5 ? teamB.push(p) : subsB.push(p);
    }
  });

  return { teamA, teamB, subsA, subsB };
}

function renderText(game) {
  const { teamA, teamB, subsA, subsB } = game;

  let text = "⚽️ **تقسیم تیم‌ها**\n\n";

  text += "🔴 تیم A:\n";
  teamA.forEach((p, i) => {
    text += `${i === 0 ? "🧤" : "👤"} ${p}\n`;
  });

  text += "\n🔵 تیم B:\n";
  teamB.forEach((p, i) => {
    text += `${i === 0 ? "🧤" : "👤"} ${p}\n`;
  });

  if (subsA.length || subsB.length) {
    text += "\n🔄 تعویضی‌ها:\n";
    [...subsA, ...subsB].forEach(p => {
      text += `➖ ${p}\n`;
    });
  }

  return text;
}

/* ================== COMMANDS ================== */

bot.onText(/\/startgame/, msg => {
  const chatId = msg.chat.id;

  games[chatId] = {
    players: [],
    messageId: null
  };

  bot.sendMessage(chatId, "👥 بازی شروع شد\nاسم بازیکن‌ها رو بفرست\nوقتی تموم شد بزن /done");
});

bot.onText(/\/done/, msg => {
  const chatId = msg.chat.id;
  const game = games[chatId];
  if (!game || game.players.length < 2) return;

  const teams = buildTeams(game.players);
  games[chatId] = { ...game, ...teams };

  const text = renderText(games[chatId]);

  bot.sendMessage(chatId, text, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔀 قاطی کن دوباره", callback_data: "reshuffle" }]
      ]
    }
  }).then(m => {
    games[chatId].messageId = m.message_id;
  });
});

bot.on("message", msg => {
  const chatId = msg.chat.id;
  if (!games[chatId]) return;
  if (msg.text.startsWith("/")) return;

  games[chatId].players.push(msg.text);
});

/* ================== CALLBACK ================== */

bot.on("callback_query", query => {
  const chatId = query.message.chat.id;

  if (query.from.id !== ADMIN_ID) {
    return bot.answerCallbackQuery(query.id, {
      text: "⛔ فقط ادمین",
      show_alert: true
    });
  }

  if (query.data === "reshuffle") {
    const game = games[chatId];
    if (!game) return;

    const teams = buildTeams(game.players);
    games[chatId] = { ...game, ...teams };

    bot.editMessageText(renderText(games[chatId]), {
      chat_id: chatId,
      message_id: game.messageId,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔀 قاطی کن دوباره", callback_data: "reshuffle" }]
        ]
      }
    });

    bot.answerCallbackQuery(query.id, { text: "🔄 تیم‌ها قاطی شد" });
  }
});
