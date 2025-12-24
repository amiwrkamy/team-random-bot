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
function shuffle(a) {
  return a.sort(() => Math.random() - 0.5);
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
  session.teams.forEach((t, i) => {
    out += `🔵 تیم ${i + 1} — ${t.length} نفر\n`;
    out += t.map(n => `⚽ ${n}`).join("\n") || "—";
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
    teamsCount: 2,
    users: new Map(),
    teams: [[], []],
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

  if (session.users.has(userId)) {
    return bot.answerCallbackQuery(q.id, {
      text: "قبلاً ثبت‌نام کردی",
      show_alert: true
    });
  }

  if (q.data === "JOIN_PLAYER") {
    session.users.set(userId, name);
    const idx = session.teams.reduce(
      (a, b, i, arr) => (b.length < arr[a].length ? i : a),
      0
    );
    session.teams[idx].push(name);
  }

  if (q.data === "RESHUFFLE") {
    const admins = await bot.getChatAdministrators(chatId);
    if (!admins.find(a => a.user.id === userId))
      return bot.answerCallbackQuery(q.id, {
        text: "فقط ادمین",
        show_alert: true
      });

    const all = shuffle([...session.users.values()]);
    session.teams = [[], []];
    all.forEach((n, i) => session.teams[i % 2].push(n));
  }

  await safeUpdate(chatId, session);
  await bot.answerCallbackQuery(q.id);
});

console.log("✅ Bot is running");
