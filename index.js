const TelegramBot = require("node-telegram-bot-api");
const BOT_TOKEN = "PUT_YOUR_BOT_TOKEN_HERE";

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

/* =======================
   حافظه سشن‌ها
======================= */
const privateSessions = {};
const groupSessions = {};

/* =======================
   ابزارها
======================= */
function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

function isAdmin(chatId, userId) {
  return bot.getChatAdministrators(chatId)
    .then(admins => admins.some(a => a.user.id === userId));
}

/* =======================
   /start
======================= */
bot.onText(/\/start$/, msg => {
  if (msg.chat.type !== "private") return;

  bot.sendMessage(msg.chat.id, "🎮 حالت استفاده را انتخاب کن", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🤖 داخل ربات", callback_data: "MODE_PRIVATE" }],
        [{ text: "👥 داخل گروه", callback_data: "MODE_GROUP" }]
      ]
    }
  });
});

/* =======================
   CALLBACK HANDLER
======================= */
bot.on("callback_query", async q => {
  const { id, data, message, from } = q;
  const chatId = message.chat.id;

  /* ---------- داخل ربات ---------- */
  if (data === "MODE_PRIVATE") {
    privateSessions[from.id] = { step: "TEAMS" };

    return bot.editMessageText("🔢 چند تیم؟", {
      chat_id: chatId,
      message_id: message.message_id,
      reply_markup: {
        inline_keyboard: [
          [{ text: "۲ تیم ⚽", callback_data: "P_TEAMS_2" }],
          [{ text: "۳ تیم ⚽", callback_data: "P_TEAMS_3" }],
          [{ text: "۴ تیم ⚽", callback_data: "P_TEAMS_4" }]
        ]
      }
    });
  }

  if (data.startsWith("P_TEAMS_")) {
    const teams = Number(data.split("_")[2]);
    privateSessions[from.id] = { teams, names: [] };

    return bot.sendMessage(chatId,
      "✍️ اسامی را بفرست (هر خط یک نفر)\n\nمثال:\nعلی\nرضا\nمهدی"
    );
  }

  /* ---------- داخل گروه ---------- */
  if (data === "MODE_GROUP") {
    const link = `https://t.me/${bot.username}?startgroup=true`;
    return bot.sendMessage(chatId, "➕ ربات را به گروه اضافه کن", {
      reply_markup: {
        inline_keyboard: [[{ text: "افزودن به گروه", url: link }]]
      }
    });
  }

  if (data.startsWith("G_TEAMS_")) {
    const teams = Number(data.split("_")[2]);
    groupSessions[chatId] = {
      teams,
      players: {},
      goalkeepers: {},
      messageId: null
    };

    return sendLiveBoard(chatId);
  }

  /* ---------- ثبت نقش ---------- */
  if (data === "JOIN_PLAYER" || data === "JOIN_GK") {
    const session = groupSessions[chatId];
    if (!session) return;

    if (session.players[from.id] || session.goalkeepers[from.id]) {
      return bot.answerCallbackQuery(id, {
        text: "❌ قبلاً ثبت‌نام کردی",
        show_alert: true
      });
    }

    if (data === "JOIN_GK") {
      if (Object.keys(session.goalkeepers).length >= session.teams) {
        return bot.answerCallbackQuery(id, {
          text: "❌ تعداد دروازه‌بان تکمیل شده",
          show_alert: true
        });
      }
      session.goalkeepers[from.id] = from.first_name;
    } else {
      session.players[from.id] = from.first_name;
    }

    await sendLiveBoard(chatId);
    return bot.answerCallbackQuery(id, { text: "✅ ثبت شد" });
  }

  /* ---------- قاطی دوباره ---------- */
  if (data === "RESHUFFLE") {
    const admin = await isAdmin(chatId, from.id);
    if (!admin) {
      return bot.answerCallbackQuery(id, {
        text: "❌ فقط ادمین",
        show_alert: true
      });
    }
    await sendLiveBoard(chatId, true);
    return bot.answerCallbackQuery(id, { text: "🔀 تیم‌ها قاطی شد" });
  }
});

/* =======================
   پیام پرایوت (اسامی)
======================= */
bot.on("message", msg => {
  if (msg.chat.type !== "private") return;
  const session = privateSessions[msg.from.id];
  if (!session || !session.teams) return;

  const names = msg.text.split("\n").map(t => t.trim()).filter(Boolean);
  shuffle(names);

  const teams = Array.from({ length: session.teams }, () => []);
  names.forEach((n, i) => teams[i % session.teams].push(n));

  let out = "🏆 نتیجه قرعه‌کشی:\n\n";
  teams.forEach((t, i) => {
    out += `🔵 تیم ${i + 1}:\n`;
    t.forEach(p => out += `• ${p}\n`);
    out += "\n";
  });

  bot.sendMessage(msg.chat.id, out);
  delete privateSessions[msg.from.id];
});

/* =======================
   برد زنده گروه
======================= */
async function sendLiveBoard(chatId, reshuffle = false) {
  const s = groupSessions[chatId];
  const gks = Object.values(s.goalkeepers);
  const pls = Object.values(s.players);

  let players = [...pls];
  if (reshuffle) shuffle(players);

  const teams = Array.from({ length: s.teams }, (_, i) => ({
    gk: gks[i] || "—",
    players: []
  }));

  players.forEach((p, i) => {
    const t = teams[i % s.teams];
    if (t.players.length < 4) t.players.push(p);
  });

  let text = "🏆 وضعیت تیم‌ها (لایو)\n\n";
  teams.forEach((t, i) => {
    text += `🔵 تیم ${i + 1}\n`;
    text += `🧤 ${t.gk}\n`;
    t.players.forEach(p => text += `⚽ ${p}\n`);
    text += "\n";
  });

  const keyboard = {
    inline_keyboard: [
      [
        { text: "⚽ بازیکن", callback_data: "JOIN_PLAYER" },
        { text: "🧤 دروازه‌بان", callback_data: "JOIN_GK" }
      ],
      [{ text: "🔀 قاطی دوباره (ادمین)", callback_data: "RESHUFFLE" }]
    ]
  };

  if (!s.messageId) {
    const m = await bot.sendMessage(chatId, text, { reply_markup: keyboard });
    s.messageId = m.message_id;
  } else {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: s.messageId,
      reply_markup: keyboard
    });
  }
}

/* =======================
   شروع تیم در گروه
======================= */
bot.onText(/\/start_team/, msg => {
  if (msg.chat.type === "private") return;

  bot.sendMessage(msg.chat.id, "🔢 تعداد تیم‌ها را انتخاب کن", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "۲ تیم", callback_data: "G_TEAMS_2" }],
        [{ text: "۳ تیم", callback_data: "G_TEAMS_3" }],
        [{ text: "۴ تیم", callback_data: "G_TEAMS_4" }]
      ]
    }
  });
});
