const TelegramBot = require("node-telegram-bot-api");
const TOKEN = process.env.BOT_TOKEN || "PUT_YOUR_TOKEN_HERE";

const bot = new TelegramBot(TOKEN, { polling: true });

/* =======================
   حافظه سشن‌ها
======================= */
const groupSessions = {};
const privateSessions = {};

/* =======================
   کیبوردها
======================= */
const startKeyboard = {
  inline_keyboard: [
    [{ text: "🤖 داخل ربات", callback_data: "MODE_PRIVATE" }],
    [{ text: "👥 داخل گروه", callback_data: "MODE_GROUP" }]
  ]
};

const teamCountKeyboard = {
  inline_keyboard: [
    [{ text: "2️⃣ دو تیم", callback_data: "TEAMS_2" }],
    [{ text: "3️⃣ سه تیم", callback_data: "TEAMS_3" }],
    [{ text: "4️⃣ چهار تیم", callback_data: "TEAMS_4" }]
  ]
};

const groupActionKeyboard = {
  inline_keyboard: [
    [
      { text: "⚽ بازیکن", callback_data: "JOIN_PLAYER" },
      { text: "🧤 دروازه‌بان", callback_data: "JOIN_GK" }
    ],
    [
      { text: "🔀 قاطی‌کردن دوباره (ادمین)", callback_data: "RESHUFFLE" }
    ]
  ]
};

/* =======================
   ابزارها
======================= */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function isRegistered(session, userId) {
  return (
    session.players.some(p => p.id === userId) ||
    session.gks.some(g => g.id === userId)
  );
}

/* =======================
   رندر لایو گروه (❗مهم)
======================= */
function renderGroup(chatId) {
  const s = groupSessions[chatId];
  if (!s) return;

  let text = "🏆 وضعیت تیم‌ها (لایو)\n\n";

  for (let i = 0; i < s.teams; i++) {
    const gk = s.gks[i] ? `🧤 ${s.gks[i].name}` : "—";
    const players = s.players
      .filter(p => p.team === i)
      .map(p => `⚽ ${p.name}`);

    text += `🔵 تیم ${i + 1}\n`;
    text += `${gk}\n`;
    text += players.join("\n") || "—";
    text += "\n\n";
  }

  const subs = s.players.filter(p => p.team === null).map(p => p.name);
  text += `🔄 تعویضی‌ها: ${subs.join("، ") || "—"}\n`;
  text += `📌 هر نفر فقط یک‌بار می‌تواند ثبت‌نام کند.\n`;
  text += `👑 فقط ادمین می‌تواند «🔀 قاطی‌کردن دوباره» را اجرا کند.`;

  if (!s.messageId) {
    bot.sendMessage(chatId, text, {
      reply_markup: groupActionKeyboard
    }).then(m => {
      s.messageId = m.message_id;
    });
  } else {
    bot.editMessageText(text, {
      chat_id: chatId,
      message_id: s.messageId,
      reply_markup: groupActionKeyboard
    });
  }
}

/* =======================
   /start
======================= */
bot.onText(/\/start/, msg => {
  if (msg.chat.type === "private") {
    bot.sendMessage(msg.chat.id, "⚽ حالت رو انتخاب کن:", {
      reply_markup: startKeyboard
    });
  } else {
    bot.sendMessage(msg.chat.id, "🔢 تعداد تیم‌ها را انتخاب کنید:", {
      reply_markup: teamCountKeyboard
    });
  }
});

/* =======================
   Callback ها
======================= */
bot.on("callback_query", async q => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const data = q.data;

  /* ===== انتخاب حالت ===== */
  if (data === "MODE_PRIVATE") {
    privateSessions[userId] = {};
    bot.sendMessage(chatId, "🔢 چند تیم می‌خوای؟", {
      reply_markup: teamCountKeyboard
    });
  }

  if (data === "MODE_GROUP") {
    const url = `https://t.me/${bot.username}?startgroup=true`;
    bot.sendMessage(chatId, "ربات رو به گروه اضافه کن 👇", {
      reply_markup: {
        inline_keyboard: [[{ text: "➕ افزودن به گروه", url }]]
      }
    });
  }

  /* ===== تعداد تیم ===== */
  if (data.startsWith("TEAMS_")) {
    const count = Number(data.split("_")[1]);

    if (q.message.chat.type === "group" || q.message.chat.type === "supergroup") {
      groupSessions[chatId] = {
        teams: count,
        players: [],
        gks: [],
        messageId: null
      };
      renderGroup(chatId);
    } else {
      privateSessions[userId].teams = count;
      privateSessions[userId].awaitingNames = true;
      bot.sendMessage(chatId, "✍️ اسم‌ها رو بفرست (هر خط یک نفر)");
    }
  }

  /* ===== ثبت بازیکن ===== */
  if (data === "JOIN_PLAYER") {
    const s = groupSessions[chatId];
    if (!s || isRegistered(s, userId)) return;

    const teams = [...Array(s.teams).keys()];
    shuffle(teams);

    let assigned = false;
    for (let t of teams) {
      const count =
        s.players.filter(p => p.team === t).length +
        (s.gks[t] ? 1 : 0);

      if (count < 5) {
        s.players.push({ id: userId, name: q.from.first_name, team: t });
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      s.players.push({ id: userId, name: q.from.first_name, team: null });
    }

    renderGroup(chatId);
  }

  /* ===== ثبت دروازه‌بان ===== */
  if (data === "JOIN_GK") {
    const s = groupSessions[chatId];
    if (!s || isRegistered(s, userId)) return;

    const freeTeams = [];
    for (let i = 0; i < s.teams; i++) {
      if (!s.gks[i]) freeTeams.push(i);
    }
    if (!freeTeams.length) return;

    const t = freeTeams[Math.floor(Math.random() * freeTeams.length)];
    s.gks[t] = { id: userId, name: q.from.first_name };

    renderGroup(chatId);
  }

  /* ===== شانس دوباره (ادمین) ===== */
  if (data === "RESHUFFLE") {
    const admins = await bot.getChatAdministrators(chatId);
    if (!admins.some(a => a.user.id === userId)) return;

    const s = groupSessions[chatId];
    if (!s) return;

    const allPlayers = [...s.players, ...s.gks.map(g => ({ ...g }))];
    shuffle(allPlayers);

    s.players = [];
    s.gks = [];

    allPlayers.forEach(p => {
      if (s.gks.length < s.teams && Math.random() < 0.3) {
        s.gks.push(p);
      } else {
        s.players.push({ ...p, team: null });
      }
    });

    renderGroup(chatId);
  }
});
