const TelegramBot = require("node-telegram-bot-api");
const TOKEN = process.env.BOT_TOKEN || "PUT_TOKEN_HERE";
const bot = new TelegramBot(TOKEN, { polling: true });

const sessions = {};

const shuffle = arr => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const initTeams = n =>
  Array.from({ length: n }, () => ({ gk: null, players: [] }));

const keyboardStart = {
  inline_keyboard: [
    [{ text: "🤖 داخل ربات", callback_data: "MODE_PRIVATE" }],
    [{ text: "👥 داخل گروه", callback_data: "MODE_GROUP" }]
  ]
};

const keyboardTeams = prefix => ({
  inline_keyboard: [
    [{ text: "2️⃣ تیم", callback_data: `${prefix}_2` }],
    [{ text: "3️⃣ تیم", callback_data: `${prefix}_3` }],
    [{ text: "4️⃣ تیم", callback_data: `${prefix}_4` }]
  ]
});

const keyboardJoin = {
  inline_keyboard: [
    [
      { text: "⚽ بازیکن", callback_data: "JOIN_PLAYER" },
      { text: "🧤 دروازه‌بان", callback_data: "JOIN_GK" }
    ],
    [{ text: "🔀 قاطی‌کردن دوباره", callback_data: "RESHUFFLE" }]
  ]
};

function render(session) {
  let txt = "🏆 وضعیت تیم‌ها (لایو)\n\n";
  session.teams.forEach((t, i) => {
    txt += `🔵 تیم ${i + 1}\n`;
    if (t.gk) txt += `🧤 ${t.gk}\n`;
    t.players.forEach(p => (txt += `⚽ ${p}\n`));
    txt += "\n";
  });
  if (session.subs.length)
    txt += "🔄 تعویضی‌ها:\n" + session.subs.join("\n") + "\n\n";
  txt += "📌 هر نفر فقط یک‌بار می‌تواند ثبت‌نام کند.";
  return txt;
}

/* ===== /start_team ===== */
bot.onText(/^\/start_team$/, msg => {
  const id = msg.chat.id;

  sessions[id] = {
    step: "MODE",
    mode: null,
    teamCount: null,
    teams: [],
    subs: [],
    users: {},
    messageId: null
  };

  bot.sendMessage(id, "🎮 حالت اجرا را انتخاب کن:", {
    reply_markup: keyboardStart
  });
});

/* ===== CALLBACK ===== */
bot.on("callback_query", async q => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const data = q.data;
  const s = sessions[chatId];
  if (!s) return bot.answerCallbackQuery(q.id);

  /* انتخاب حالت */
  if (data === "MODE_PRIVATE") {
    s.mode = "PRIVATE";
    s.step = "TEAM_SELECT";
    return bot.editMessageText("🔢 تعداد تیم‌ها را انتخاب کن:", {
      chat_id: chatId,
      message_id: q.message.message_id,
      reply_markup: keyboardTeams("P")
    });
  }

  if (data === "MODE_GROUP") {
    s.mode = "GROUP";
    s.step = "TEAM_SELECT";
    return bot.editMessageText("🔢 تعداد تیم‌ها را انتخاب کن:", {
      chat_id: chatId,
      message_id: q.message.message_id,
      reply_markup: keyboardTeams("G")
    });
  }

  /* انتخاب تعداد تیم */
  if (data.startsWith("G_")) {
    s.teamCount = Number(data.split("_")[1]);
    s.teams = initTeams(s.teamCount);
    s.step = "REGISTER";

    const sent = await bot.editMessageText("🎯 نقش خود را انتخاب کن:", {
      chat_id: chatId,
      message_id: q.message.message_id,
      reply_markup: keyboardJoin
    });

    s.messageId = q.message.message_id;
    return;
  }

  /* ثبت نقش */
  if (data === "JOIN_PLAYER" || data === "JOIN_GK") {
    if (s.users[userId]) return bot.answerCallbackQuery(q.id, { text: "قبلاً ثبت شدی" });
    s.users[userId] = true;

    const name = q.from.first_name;
    if (data === "JOIN_GK") {
      const t = s.teams.find(x => !x.gk);
      if (!t) return bot.answerCallbackQuery(q.id, { text: "گلر تکمیل شد" });
      t.gk = name;
    } else {
      const sorted = [...s.teams].sort((a, b) => a.players.length - b.players.length);
      const t = sorted.find(x => x.players.length < 4);
      t ? t.players.push(name) : s.subs.push(name);
    }

    return bot.editMessageText(render(s), {
      chat_id: chatId,
      message_id: s.messageId,
      reply_markup: keyboardJoin
    });
  }

  /* قاطی کردن */
  if (data === "RESHUFFLE") {
    const admins = await bot.getChatAdministrators(chatId);
    if (!admins.some(a => a.user.id === userId))
      return bot.answerCallbackQuery(q.id, { text: "فقط ادمین" });

    const all = [];
    s.teams.forEach(t => {
      if (t.gk) all.push({ n: t.gk, r: "gk" });
      t.players.forEach(p => all.push({ n: p, r: "p" }));
    });
    s.subs.forEach(x => all.push({ n: x, r: "p" }));

    s.teams = initTeams(s.teamCount);
    s.subs = [];

    shuffle(all.filter(x => x.r === "gk")).slice(0, s.teamCount)
      .forEach((g, i) => (s.teams[i].gk = g.n));

    shuffle(all.filter(x => x.r === "p")).forEach(p => {
      const t = s.teams.sort((a, b) => a.players.length - b.players.length)[0];
      t.players.length < 4 ? t.players.push(p.n) : s.subs.push(p.n);
    });

    return bot.editMessageText(render(s), {
      chat_id: chatId,
      message_id: s.messageId,
      reply_markup: keyboardJoin
    });
  }

  bot.answerCallbackQuery(q.id);
});
