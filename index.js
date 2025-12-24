import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ BOT_TOKEN is missing");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

/* ================== STATE ================== */
const groups = {}; // chatId -> state

function getGroup(chatId) {
  if (!groups[chatId]) {
    groups[chatId] = {
      teams: 0,
      players: [],
      goalkeepers: [],
      messageId: null
    };
  }
  return groups[chatId];
}

/* ================== START ================== */
bot.onText(/^\/start$/, async (msg) => {
  if (msg.chat.type !== "private") return;

  await bot.sendMessage(msg.chat.id, "🎯 حالت را انتخاب کن:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🤖 داخل ربات", callback_data: "MODE_PRIVATE" }],
        [{ text: "👥 داخل گروه", callback_data: "MODE_GROUP" }]
      ]
    }
  });
});

/* ================== START TEAM (GROUP) ================== */
bot.onText(/^\/start_team$/, async (msg) => {
  if (msg.chat.type === "private") return;

  await bot.sendMessage(msg.chat.id, "🔢 تعداد تیم‌ها را انتخاب کن:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "۲ تیم ⚽", callback_data: "TEAMS_2" }],
        [{ text: "۳ تیم ⚽", callback_data: "TEAMS_3" }],
        [{ text: "۴ تیم ⚽", callback_data: "TEAMS_4" }]
      ]
    }
  });
});

/* ================== CALLBACKS ================== */
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const user = q.from;
  const data = q.data;

  /* ---------- PRIVATE MODE ---------- */
  if (data === "MODE_GROUP") {
    return bot.sendMessage(chatId,
      "➕ ربات را به گروه اضافه کن و داخل گروه دستور زیر را بزن:\n\n/start_team"
    );
  }

  if (data.startsWith("TEAMS_")) {
    const teamCount = Number(data.split("_")[1]);
    const g = getGroup(chatId);
    g.teams = teamCount;
    g.players = [];
    g.goalkeepers = [];

    const sent = await bot.sendMessage(chatId,
      "🎯 نقش خود را انتخاب کن:",
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "⚽ بازیکن", callback_data: "JOIN_PLAYER" },
              { text: "🧤 دروازه‌بان", callback_data: "JOIN_GK" }
            ],
            [
              { text: "🔀 قاطی‌کردن دوباره (ادمین)", callback_data: "RESHUFFLE" }
            ]
          ]
        }
      }
    );

    g.messageId = sent.message_id;
    return;
  }

  /* ---------- JOIN PLAYER ---------- */
  if (data === "JOIN_PLAYER") {
    const g = getGroup(chatId);
    if (g.players.find(p => p.id === user.id) ||
        g.goalkeepers.find(p => p.id === user.id)) {
      return bot.answerCallbackQuery(q.id, {
        text: "❗ قبلاً ثبت‌نام کردی",
        show_alert: true
      });
    }

    g.players.push({ id: user.id, name: user.first_name });
    return updateTeams(chatId);
  }

  /* ---------- JOIN GK ---------- */
  if (data === "JOIN_GK") {
    const g = getGroup(chatId);

    if (g.goalkeepers.length >= g.teams) {
      return bot.answerCallbackQuery(q.id, {
        text: "❌ تعداد دروازه‌بان‌ها تکمیل شده",
        show_alert: true
      });
    }

    if (g.players.find(p => p.id === user.id) ||
        g.goalkeepers.find(p => p.id === user.id)) {
      return bot.answerCallbackQuery(q.id, {
        text: "❗ قبلاً ثبت‌نام کردی",
        show_alert: true
      });
    }

    g.goalkeepers.push({ id: user.id, name: user.first_name });
    return updateTeams(chatId);
  }

  /* ---------- RESHUFFLE (ADMIN ONLY) ---------- */
  if (data === "RESHUFFLE") {
    const admins = await bot.getChatAdministrators(chatId);
    const isAdmin = admins.some(a => a.user.id === user.id);

    if (!isAdmin) {
      return bot.answerCallbackQuery(q.id, {
        text: "⛔ فقط ادمین",
        show_alert: true
      });
    }

    return updateTeams(chatId, true);
  }
});

/* ================== UPDATE TEAMS ================== */
async function updateTeams(chatId, reshuffle = false) {
  const g = getGroup(chatId);

  const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);

  const gks = shuffle([...g.goalkeepers]);
  const players = shuffle([...g.players]);

  const teams = Array.from({ length: g.teams }, () => []);

  gks.forEach((gk, i) => teams[i].push("🧤 " + gk.name));

  let i = 0;
  players.forEach(p => {
    teams[i % g.teams].push("⚽ " + p.name);
    i++;
  });

  let text = "🏆 وضعیت تیم‌ها (لایو)\n\n";
  teams.forEach((t, i) => {
    text += `🔵 تیم ${i + 1} — ${t.length} نفر\n`;
    t.forEach(n => text += `  ${n}\n`);
    text += "\n";
  });

  await bot.editMessageText(text, {
    chat_id: chatId,
    message_id: g.messageId,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⚽ بازیکن", callback_data: "JOIN_PLAYER" },
          { text: "🧤 دروازه‌بان", callback_data: "JOIN_GK" }
        ],
        [
          { text: "🔀 قاطی‌کردن دوباره (ادمین)", callback_data: "RESHUFFLE" }
        ]
      ]
    }
  });
}

console.log("✅ Bot started successfully");
