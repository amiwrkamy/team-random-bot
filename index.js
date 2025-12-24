require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

const sessions = new Map();

/* ---------- UI ---------- */
const joinKeyboard = {
  inline_keyboard: [
    [
      { text: "⚽ بازیکن", callback_data: "JOIN_PLAYER" },
      { text: "🧤 دروازه‌بان", callback_data: "JOIN_GK" }
    ],
    [{ text: "🔀 قاطی‌کردن دوباره (ادمین)", callback_data: "RESHUFFLE" }]
  ]
};

/* ---------- Helpers ---------- */
function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

async function safeUpdate(chatId, session) {
  const text = render(session);
  try {
    if (session.messageId) {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: session.messageId,
        reply_markup: joinKeyboard
      });
    } else {
      const msg = await bot.sendMessage(chatId, text, {
        reply_markup: joinKeyboard
      });
      session.messageId = msg.message_id;
    }
  } catch {
    const msg = await bot.sendMessage(chatId, text, {
      reply_markup: joinKeyboard
    });
    session.messageId = msg.message_id;
  }
}

function render(session) {
  let out = "🏆 وضعیت تیم‌ها (لایو)\n\n";

  session.teams.forEach((team, i) => {
    out += `🔵 تیم ${i + 1} — ${team.players.length + team.gk.length} نفر\n`;
    if (team.gk.length)
      out += `🧤 دروازه‌بان: ${team.gk.join(", ")}\n`;
    if (team.players.length)
      out += team.players.map(p => `⚽ ${p}`).join("\n");
    if (!team.players.length && !team.gk.length) out += "—";
    out += "\n\n";
  });

  out += "📌 هر نفر فقط یک‌بار می‌تواند ثبت‌نام کند.\n";
  out += "👑 فقط ادمین می‌تواند «🔀 قاطی‌کردن دوباره» را اجرا کند.";
  return out;
}

/* ---------- Commands ---------- */
bot.onText(/\/start_team/, async msg => {
  const chatId = msg.chat.id;
  const admins = await bot.getChatAdministrators(chatId);
  if (!admins.find(a => a.user.id === msg.from.id))
    return bot.sendMessage(chatId, "⛔ فقط ادمین");

  const session = {
    users: new Map(), // userId -> { name, role }
    teams: [
      { players: [], gk: [] },
      { players: [], gk: [] }
    ],
    messageId: null
  };

  sessions.set(chatId, session);
  await safeUpdate(chatId, session);
});

/* ---------- Callbacks ---------- */
bot.on("callback_query", async q => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const name = q.from.first_name;

  const session = sessions.get(chatId);
  if (!session) return;

  /* ---- Duplicate check ---- */
  if (session.users.has(userId)) {
    return bot.answerCallbackQuery(q.id, {
      text: "⛔ قبلاً ثبت‌نام کردی",
      show_alert: true
    });
  }

  /* ---------- JOIN PLAYER ---------- */
  if (q.data === "JOIN_PLAYER") {
    session.users.set(userId, { name, role: "player" });

    const target = session.teams.reduce(
      (a, b) =>
        a.players.length + a.gk.length <= b.players.length + b.gk.length
          ? a
          : b
    );

    target.players.push(name);
  }

  /* ---------- JOIN GK ---------- */
  if (q.data === "JOIN_GK") {
    const teamWithoutGK = session.teams.find(t => t.gk.length === 0);
    if (!teamWithoutGK) {
      return bot.answerCallbackQuery(q.id, {
        text: "❌ همه تیم‌ها دروازه‌بان دارند",
        show_alert: true
      });
    }

    session.users.set(userId, { name, role: "gk" });
    teamWithoutGK.gk.push(name);
  }

  /* ---------- RESHUFFLE ---------- */
  if (q.data === "RESHUFFLE") {
    const admins = await bot.getChatAdministrators(chatId);
    if (!admins.find(a => a.user.id === userId)) {
      return bot.answerCallbackQuery(q.id, {
        text: "⛔ فقط ادمین",
        show_alert: true
      });
    }

    const gks = [];
    const players = [];

    for (const u of session.users.values()) {
      u.role === "gk" ? gks.push(u.name) : players.push(u.name);
    }

    session.teams = [
      { players: [], gk: [] },
      { players: [], gk: [] }
    ];

    shuffle(gks).forEach((gk, i) => {
      if (i < session.teams.length)
        session.teams[i].gk.push(gk);
    });

    shuffle(players).forEach((p, i) => {
      session.teams[i % session.teams.length].players.push(p);
    });
  }

  await safeUpdate(chatId, session);
  await bot.answerCallbackQuery(q.id);
});

console.log("✅ Bot is running (FINAL STABLE)");
