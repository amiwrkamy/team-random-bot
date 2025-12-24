require("dotenv").config();
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.BOT_TOKEN;
const URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 3000;

const bot = new TelegramBot(TOKEN);
bot.setWebHook(`${URL}/bot${TOKEN}`);

const app = express();
app.use(express.json());

app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("Bot is running ✅");
});

app.listen(PORT, () => {
  console.log("🚀 Bot started with webhook");
});

/* =======================
   STATE MANAGEMENT
======================= */

const sessions = {}; // chatId based

function getSession(chatId) {
  if (!sessions[chatId]) {
    sessions[chatId] = {
      mode: null,
      teamCount: null,
      players: {},
      goalkeepers: {},
      locked: false
    };
  }
  return sessions[chatId];
}

/* =======================
   START
======================= */

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(chatId, "⚽️ به ربات تیم‌کشی خوش اومدی", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🤖 داخل ربات", callback_data: "MODE_PRIVATE" }],
        [{ text: "👥 داخل گروه", callback_data: "MODE_GROUP" }]
      ]
    }
  });
});

/* =======================
   MODE SELECT
======================= */

bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const session = getSession(chatId);

  const data = q.data;

  if (data === "MODE_PRIVATE") {
    session.mode = "private";
    askTeamCount(chatId);
  }

  if (data === "MODE_GROUP") {
    bot.sendMessage(chatId, "👇 لینک افزودن ربات به گروه", {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: "➕ افزودن به گروه",
              url: `https://t.me/${(await bot.getMe()).username}?startgroup=true`
            }
          ]
        ]
      }
    });
  }

  if (data.startsWith("TEAM_")) {
    session.teamCount = Number(data.split("_")[1]);
    session.players = {};
    session.goalkeepers = {};
    session.locked = false;

    if (session.mode === "private") {
      bot.sendMessage(chatId, "✍️ اسامی رو بفرست (هر خط یک نفر)\nدروازه‌بان‌ها رو آخر با (GK) بنویس");
    } else {
      sendJoinButtons(chatId);
    }
  }

  if (data === "JOIN_PLAYER" || data === "JOIN_GK") {
    if (session.locked) return;

    if (session.players[userId] || session.goalkeepers[userId]) {
      bot.answerCallbackQuery(q.id, { text: "❌ قبلاً ثبت‌نام کردی", show_alert: true });
      return;
    }

    if (data === "JOIN_PLAYER") {
      session.players[userId] = q.from.first_name;
    } else {
      session.goalkeepers[userId] = q.from.first_name;
    }

    bot.answerCallbackQuery(q.id, { text: "✅ ثبت شد" });
  }

  if (data === "DRAW_AGAIN") {
    if (q.from.id !== q.message.chat.owner_id) return;
    drawTeams(chatId, true);
  }
});

/* =======================
   HELPERS
======================= */

function askTeamCount(chatId) {
  bot.sendMessage(chatId, "🔢 چند تیم؟", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "۲ تیم", callback_data: "TEAM_2" }],
        [{ text: "۳ تیم", callback_data: "TEAM_3" }],
        [{ text: "۴ تیم", callback_data: "TEAM_4" }]
      ]
    }
  });
}

function sendJoinButtons(chatId) {
  bot.sendMessage(chatId, "👥 شرکت در قرعه‌کشی", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "⚽️ بازیکن", callback_data: "JOIN_PLAYER" }],
        [{ text: "🧤 دروازه‌بان", callback_data: "JOIN_GK" }],
        [{ text: "🔁 شانس مجدد (ادمین)", callback_data: "DRAW_AGAIN" }]
      ]
    }
  });
}

function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

function drawTeams(chatId, redraw = false) {
  const session = getSession(chatId);
  session.locked = true;

  const teams = Array.from({ length: session.teamCount }, () => []);

  const gks = shuffle(Object.values(session.goalkeepers));
  const players = shuffle(Object.values(session.players));

  gks.forEach((gk, i) => {
    teams[i % teams.length].push("🧤 " + gk);
  });

  players.forEach((p, i) => {
    teams[i % teams.length].push("⚽️ " + p);
  });

  let text = "🏆 نتیجه قرعه‌کشی:\n\n";
  teams.forEach((t, i) => {
    text += `🔹 تیم ${i + 1}:\n${t.join("\n")}\n\n`;
  });

  bot.sendMessage(chatId, text);
}

/* =======================
   PRIVATE NAME INPUT
======================= */

bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const session = getSession(chatId);

  if (session.mode !== "private" || !session.teamCount) return;

  const lines = msg.text.split("\n");

  lines.forEach((line) => {
    if (line.toLowerCase().includes("gk")) {
      session.goalkeepers[line] = line.replace("(GK)", "").trim();
    } else {
      session.players[line] = line.trim();
    }
  });

  drawTeams(chatId);
});
