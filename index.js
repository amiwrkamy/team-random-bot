const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

const TOKEN = process.env.BOT_TOKEN;
const BASE_URL = process.env.BASE_URL;
const ADMIN_ID = Number(process.env.ADMIN_ID);

const bot = new TelegramBot(TOKEN);
const app = express();
app.use(express.json());

bot.setWebHook(`${BASE_URL}/bot${TOKEN}`);
app.post(`/bot${TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});
app.get("/", (_, res) => res.send("Bot Running"));
app.listen(process.env.PORT || 3000);

/* ================= DATA ================= */

const games = {}; // chatId => game state

function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

/* ================= START ================= */

bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, "⚽️ قرعه‌کشی تیم‌ها\n\nکجا می‌خوای؟", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🤖 داخل ربات", callback_data: "MODE_PRIVATE" }],
        [{ text: "👥 داخل گروه", callback_data: "MODE_GROUP" }]
      ]
    }
  });
});

/* ================= MODE ================= */

bot.on("callback_query", q => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;

  /* ---------- PRIVATE ---------- */
  if (q.data === "MODE_PRIVATE") {
    games[userId] = {
      mode: "private",
      step: "teams",
      players: []
    };

    return bot.editMessageText("🔢 چند تیم؟", {
      chat_id: chatId,
      message_id: q.message.message_id,
      reply_markup: {
        inline_keyboard: [
          [{ text: "2️⃣ تیم", callback_data: "T_2" }],
          [{ text: "3️⃣ تیم", callback_data: "T_3" }],
          [{ text: "4️⃣ تیم", callback_data: "T_4" }]
        ]
      }
    });
  }

  /* ---------- GROUP ---------- */
  if (q.data === "MODE_GROUP") {
    return bot.editMessageText(
      "👥 ربات رو به گروه اضافه کن و داخل گروه /startgame بزن",
      {
        chat_id: chatId,
        message_id: q.message.message_id
      }
    );
  }

  /* ---------- TEAM COUNT ---------- */
  if (q.data.startsWith("T_")) {
    const count = Number(q.data.split("_")[1]);
    const game = games[userId];
    if (!game) return;

    game.teamCount = count;
    game.step = "names";

    return bot.editMessageText(
      "✍️ اسم‌ها رو یکی‌یکی بفرست\n\nفرمت:\nنام - بازیکن\nنام - دروازه‌بان\n\nوقتی تموم شد بزن /done",
      {
        chat_id: chatId,
        message_id: q.message.message_id
      }
    );
  }

  /* ---------- GROUP JOIN ---------- */
  if (q.data.startsWith("JOIN_")) {
    const role = q.data.split("_")[1];
    const game = games[chatId];
    if (!game) return;

    if (game.registered[userId]) {
      return bot.answerCallbackQuery(q.id, {
        text: "❌ قبلاً ثبت شدی",
        show_alert: true
      });
    }

    game.registered[userId] = role;
    game.players.push({ id: userId, name: q.from.first_name, role });

    bot.answerCallbackQuery(q.id, { text: "✅ ثبت شد" });
  }

  /* ---------- RESHUFFLE ---------- */
  if (q.data === "RESHUFFLE") {
    if (userId !== ADMIN_ID) {
      return bot.answerCallbackQuery(q.id, {
        text: "⛔ فقط ادمین",
        show_alert: true
      });
    }
    return drawTeams(chatId, true);
  }
});

/* ================= PRIVATE INPUT ================= */

bot.on("message", msg => {
  const userId = msg.from.id;
  const game = games[userId];
  if (!game || game.mode !== "private") return;
  if (msg.text.startsWith("/")) return;

  const [name, role] = msg.text.split("-").map(t => t.trim());
  if (!name || !role) return;

  game.players.push({
    name,
    role: role.includes("دروازه") ? "GK" : "PL"
  });
});

/* ================= DONE PRIVATE ================= */

bot.onText(/\/done/, msg => {
  const userId = msg.from.id;
  const game = games[userId];
  if (!game || game.mode !== "private") return;

  drawPrivate(msg.chat.id, game);
});

/* ================= GROUP GAME ================= */

bot.onText(/\/startgame/, msg => {
  if (msg.chat.type === "private") return;

  games[msg.chat.id] = {
    mode: "group",
    teamCount: null,
    players: [],
    registered: {},
    messageId: null
  };

  bot.sendMessage(msg.chat.id, "🔢 چند تیم؟", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "2️⃣ تیم", callback_data: "GT_2" }],
        [{ text: "3️⃣ تیم", callback_data: "GT_3" }],
        [{ text: "4️⃣ تیم", callback_data: "GT_4" }]
      ]
    }
  });
});

/* ================= GROUP TEAM COUNT ================= */

bot.on("callback_query", q => {
  if (!q.data.startsWith("GT_")) return;

  const chatId = q.message.chat.id;
  const game = games[chatId];
  if (!game) return;

  game.teamCount = Number(q.data.split("_")[1]);

  bot.editMessageText("👥 ثبت‌نام:", {
    chat_id: chatId,
    message_id: q.message.message_id,
    reply_markup: {
      inline_keyboard: [
        [{ text: "👤 بازیکن", callback_data: "JOIN_PL" }],
        [{ text: "🧤 دروازه‌بان", callback_data: "JOIN_GK" }],
        [{ text: "🔀 شانس دوباره (ادمین)", callback_data: "RESHUFFLE" }]
      ]
    }
  }).then(m => {
    game.messageId = m.message_id;
  });
});

/* ================= DRAW ================= */

function drawTeams(chatId, edit = false) {
  const game = games[chatId];
  if (!game) return;

  const gks = shuffle(game.players.filter(p => p.role === "GK"));
  const pls = shuffle(game.players.filter(p => p.role === "PL"));

  const teams = Array.from({ length: game.teamCount }, () => []);

  teams.forEach((t, i) => {
    if (gks[i]) t.push(gks[i]);
  });

  pls.forEach(p => {
    const t = teams.reduce((a, b) => (a.length <= b.length ? a : b));
    if (t.length < 5) t.push(p);
  });

  let text = "⚽️ نتیجه قرعه‌کشی\n\n";
  teams.forEach((t, i) => {
    text += `🏷 تیم ${i + 1}\n`;
    t.forEach(p => {
      text += `${p.role === "GK" ? "🧤" : "👤"} ${p.name}\n`;
    });
    text += "\n";
  });

  bot.editMessageText(text, {
    chat_id: chatId,
    message_id: game.messageId,
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔀 شانس دوباره (ادمین)", callback_data: "RESHUFFLE" }]
      ]
    }
  });
}

function drawPrivate(chatId, game) {
  const teams = Array.from({ length: game.teamCount }, () => []);
  shuffle(game.players).forEach(p => {
    const t = teams.reduce((a, b) => (a.length <= b.length ? a : b));
    t.push(p);
  });

  let text = "⚽️ نتیجه قرعه‌کشی\n\n";
  teams.forEach((t, i) => {
    text += `🏷 تیم ${i + 1}\n`;
    t.forEach(p => {
      text += `${p.role === "GK" ? "🧤" : "👤"} ${p.name}\n`;
    });
    text += "\n";
  });

  bot.sendMessage(chatId, text);
    }
