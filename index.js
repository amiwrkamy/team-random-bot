import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN || "PUT_YOUR_BOT_TOKEN_HERE";
const bot = new TelegramBot(TOKEN, { polling: true });

console.log("✅ BOT RUNNING");

const privateSessions = {};
const groupSessions = {};

/* ---------------- START ---------------- */
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type === "private") {
    bot.sendMessage(chatId, "🎯 حالت اجرا را انتخاب کن:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🤖 داخل ربات", callback_data: "MODE_PRIVATE" }],
          [{ text: "👥 داخل گروه", callback_data: "MODE_GROUP" }]
        ]
      }
    });
  } else {
    sendTeamCountSelector(chatId);
  }
});

/* ---------------- CALLBACK ---------------- */
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const data = q.data;

  /* -------- PRIVATE MODE -------- */
  if (data === "MODE_PRIVATE") {
    privateSessions[chatId] = {};
    return sendTeamCountSelector(chatId, true);
  }

  if (data.startsWith("P_TEAMS_")) {
    const teams = Number(data.split("_")[2]);
    privateSessions[chatId] = { teams };
    return bot.sendMessage(
      chatId,
      "✍️ اسامی را بفرست:\n\nدروازه‌بان‌ها:\nAli\nReza\n\nبازیکن‌ها:\nAmir\nSina"
    );
  }

  /* -------- GROUP MODE -------- */
  if (data === "MODE_GROUP") {
    const url = `https://t.me/${(await bot.getMe()).username}?startgroup=true`;
    return bot.sendMessage(chatId, "➕ ربات را به گروه اضافه کن:", {
      reply_markup: { inline_keyboard: [[{ text: "افزودن به گروه", url }]] }
    });
  }

  if (data.startsWith("G_TEAMS_")) {
    const teams = Number(data.split("_")[2]);
    groupSessions[chatId] = {
      teams,
      players: [],
      gks: [],
      messageId: null
    };
    return sendJoinButtons(chatId);
  }

  const session = groupSessions[chatId];
  if (!session) return;

  if (data === "JOIN_PLAYER") {
    if (session.players.find(p => p.id === userId) || session.gks.find(p => p.id === userId))
      return bot.answerCallbackQuery(q.id, { text: "❌ قبلاً ثبت شدی" });

    session.players.push({ id: userId, name: q.from.first_name });
    return updateGroupStatus(chatId);
  }

  if (data === "JOIN_GK") {
    if (session.gks.length >= session.teams)
      return bot.answerCallbackQuery(q.id, { text: "❌ دروازه‌بان‌ها تکمیل شدند" });

    if (session.players.find(p => p.id === userId) || session.gks.find(p => p.id === userId))
      return bot.answerCallbackQuery(q.id, { text: "❌ قبلاً ثبت شدی" });

    session.gks.push({ id: userId, name: q.from.first_name });
    return updateGroupStatus(chatId);
  }

  if (data === "RESHUFFLE") {
    const admins = await bot.getChatAdministrators(chatId);
    if (!admins.find(a => a.user.id === userId))
      return bot.answerCallbackQuery(q.id, { text: "❌ فقط ادمین", show_alert: true });

    return distribute(chatId);
  }
});

/* ---------------- PRIVATE TEXT ---------------- */
bot.on("message", (msg) => {
  if (msg.chat.type !== "private") return;
  const session = privateSessions[msg.chat.id];
  if (!session || !session.teams) return;

  const lines = msg.text.split("\n");
  let mode = "";
  const gks = [], players = [];

  for (const l of lines) {
    if (l.includes("دروازه")) mode = "gk";
    else if (l.includes("بازیکن")) mode = "p";
    else if (l.trim()) {
      mode === "gk" ? gks.push(l.trim()) : players.push(l.trim());
    }
  }

  if (gks.length < session.teams)
    return bot.sendMessage(msg.chat.id, "❌ تعداد دروازه‌بان کم است");

  const teams = makeTeams(session.teams, gks, players);
  bot.sendMessage(msg.chat.id, formatTeams(teams));
  delete privateSessions[msg.chat.id];
});

/* ---------------- HELPERS ---------------- */
function sendTeamCountSelector(chatId, isPrivate = false) {
  const prefix = isPrivate ? "P" : "G";
  bot.sendMessage(chatId, "🔢 تعداد تیم‌ها:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "۲ تیم ⚽", callback_data: `${prefix}_TEAMS_2` }],
        [{ text: "۳ تیم ⚽", callback_data: `${prefix}_TEAMS_3` }],
        [{ text: "۴ تیم ⚽", callback_data: `${prefix}_TEAMS_4` }]
      ]
    }
  });
}

function sendJoinButtons(chatId) {
  bot.sendMessage(chatId, "🎯 نقش خود را انتخاب کن:", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⚽ بازیکن", callback_data: "JOIN_PLAYER" },
          { text: "🥅 دروازه‌بان", callback_data: "JOIN_GK" }
        ],
        [{ text: "🔀 شانس دوباره (ادمین)", callback_data: "RESHUFFLE" }]
      ]
    }
  });
}

function updateGroupStatus(chatId) {
  const s = groupSessions[chatId];
  const text =
    `🏆 وضعیت تیم‌ها\n\n` +
    `🥅 دروازه‌بان‌ها: ${s.gks.map(p => p.name).join(", ") || "—"}\n` +
    `⚽ بازیکن‌ها: ${s.players.map(p => p.name).join(", ") || "—"}\n\n` +
    `📌 هر نفر فقط یک‌بار`;

  if (s.messageId) {
    bot.editMessageText(text, { chat_id: chatId, message_id: s.messageId });
  } else {
    bot.sendMessage(chatId, text).then(m => (s.messageId = m.message_id));
  }

  if (s.gks.length === s.teams) distribute(chatId);
}

function distribute(chatId) {
  const s = groupSessions[chatId];
  const teams = makeTeams(s.teams, s.gks.map(x => x.name), s.players.map(x => x.name));
  bot.sendMessage(chatId, formatTeams(teams));
}

function makeTeams(count, gks, players) {
  shuffle(gks);
  shuffle(players);

  const teams = Array.from({ length: count }, (_, i) => [`🥅 ${gks[i]}`]);
  let i = 0;

  for (const p of players) {
    teams[i % count].length < 5 && teams[i % count].push(`⚽ ${p}`);
    i++;
  }
  return teams;
}

function formatTeams(teams) {
  return teams
    .map((t, i) => `🔵 تیم ${i + 1}\n${t.join("\n")}`)
    .join("\n\n");
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  }
