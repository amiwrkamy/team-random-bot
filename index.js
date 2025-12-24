const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.BOT_TOKEN || "PUT_YOUR_TOKEN_HERE";
const bot = new TelegramBot(TOKEN, { polling: true });

/* =======================
   حافظه اصلی (State)
======================= */
const sessions = {}; // key: chatId

/* =======================
   ابزارهای کمکی
======================= */
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function initTeams(teamCount) {
  return Array.from({ length: teamCount }, () => ({
    gk: null,
    players: [],
    subs: []
  }));
}

function renderTeams(session) {
  let text = "🏆 وضعیت تیم‌ها (لایو)\n\n";

  session.teams.forEach((t, i) => {
    const members = [];
    if (t.gk) members.push(`🧤 ${t.gk}`);
    t.players.forEach(p => members.push(`⚽ ${p}`));

    text += `🔵 تیم ${i + 1} — ${members.length} نفر\n`;
    text += members.length ? members.join("\n") : "—";
    text += "\n\n";
  });

  if (session.subs.length) {
    text += "🔄 تعویضی‌ها:\n";
    text += session.subs.map(x => `• ${x}`).join("\n") + "\n\n";
  }

  text += "📌 هر نفر فقط یک‌بار می‌تواند ثبت‌نام کند.\n";
  text += "👑 فقط ادمین می‌تواند «🔀 قاطی‌کردن دوباره» را اجرا کند.";

  return text;
}

function reshuffle(session) {
  const all = [];

  session.teams.forEach(t => {
    if (t.gk) all.push({ name: t.gk, role: "gk" });
    t.players.forEach(p => all.push({ name: p, role: "player" }));
  });
  session.subs.forEach(s => all.push({ name: s, role: "player" }));

  session.teams = initTeams(session.teamCount);
  session.subs = [];

  const gks = shuffle(all.filter(x => x.role === "gk"));
  const players = shuffle(all.filter(x => x.role === "player"));

  gks.slice(0, session.teamCount).forEach((gk, i) => {
    session.teams[i].gk = gk.name;
  });

  players.forEach(p => {
    const sorted = [...session.teams].sort(
      (a, b) => a.players.length - b.players.length
    );
    const target = sorted.find(t => t.players.length < 4);
    if (target) target.players.push(p.name);
    else session.subs.push(p.name);
  });
}

/* =======================
   /start_team
======================= */
bot.onText(/^\/start_team$/, async msg => {
  const chatId = msg.chat.id;

  sessions[chatId] = {
    step: "MODE",
    teamCount: null,
    registered: {},
    teams: [],
    subs: [],
    messageId: null
  };

  await bot.sendMessage(chatId, "🎮 حالت اجرا را انتخاب کن:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🤖 داخل ربات", callback_data: "MODE_PRIVATE" }],
        [{ text: "👥 داخل گروه", callback_data: "MODE_GROUP" }]
      ]
    }
  });
});

/* =======================
   Callback ها
======================= */
bot.on("callback_query", async q => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const data = q.data;

  await bot.answerCallbackQuery(q.id);

  const session = sessions[chatId];
  if (!session) return;

  /* انتخاب حالت */
  if (data === "MODE_PRIVATE") {
    session.step = "PRIVATE_TEAMS";
    return bot.sendMessage(chatId, "🔢 چند تیم؟", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "2️⃣ تیم", callback_data: "P_TEAMS_2" }],
          [{ text: "3️⃣ تیم", callback_data: "P_TEAMS_3" }],
          [{ text: "4️⃣ تیم", callback_data: "P_TEAMS_4" }]
        ]
      }
    });
  }

  if (data === "MODE_GROUP") {
    return bot.sendMessage(
      chatId,
      "➕ ربات را به گروه اضافه کن و داخل گروه دستور /start_team را بزن"
    );
  }

  /* داخل گروه: تعداد تیم */
  if (data.startsWith("G_TEAMS_")) {
    const n = Number(data.split("_")[2]);
    session.teamCount = n;
    session.teams = initTeams(n);
    session.step = "REGISTER";

    const sent = await bot.sendMessage(chatId, "🎯 نقش خود را انتخاب کن", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "⚽ بازیکن", callback_data: "JOIN_PLAYER" },
            { text: "🧤 دروازه‌بان", callback_data: "JOIN_GK" }
          ],
          [{ text: "🔀 قاطی‌کردن دوباره", callback_data: "RESHUFFLE" }]
        ]
      }
    });
    session.messageId = sent.message_id;
    return;
  }

  /* ثبت بازیکن */
  if (data === "JOIN_PLAYER" || data === "JOIN_GK") {
    if (session.registered[userId]) return;

    session.registered[userId] = true;
    const name = q.from.first_name;

    if (data === "JOIN_GK") {
      const team = session.teams.find(t => !t.gk);
      if (!team) return;
      team.gk = name;
    } else {
      const sorted = [...session.teams].sort(
        (a, b) => a.players.length - b.players.length
      );
      const target = sorted.find(t => t.players.length < 4);
      if (target) target.players.push(name);
      else session.subs.push(name);
    }

    return bot.editMessageText(renderTeams(session), {
      chat_id: chatId,
      message_id: session.messageId,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "⚽ بازیکن", callback_data: "JOIN_PLAYER" },
            { text: "🧤 دروازه‌بان", callback_data: "JOIN_GK" }
          ],
          [{ text: "🔀 قاطی‌کردن دوباره", callback_data: "RESHUFFLE" }]
        ]
      }
    });
  }

  /* قاطی کردن */
  if (data === "RESHUFFLE") {
    const admins = await bot.getChatAdministrators(chatId);
    if (!admins.some(a => a.user.id === userId)) return;

    reshuffle(session);

    return bot.editMessageText(renderTeams(session), {
      chat_id: chatId,
      message_id: session.messageId,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "⚽ بازیکن", callback_data: "JOIN_PLAYER" },
            { text: "🧤 دروازه‌بان", callback_data: "JOIN_GK" }
          ],
          [{ text: "🔀 قاطی‌کردن دوباره", callback_data: "RESHUFFLE" }]
        ]
      }
    });
  }
});

/* =======================
   داخل ربات: دریافت اسامی
======================= */
bot.on("message", msg => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session) return;
  if (msg.chat.type !== "private") return;
  if (session.step !== "PRIVATE_WAIT_NAMES") return;

  const names = msg.text.split("\n").map(x => x.trim()).filter(Boolean);
  session.teams = initTeams(session.teamCount);

  const shuffled = shuffle(names);
  shuffled.forEach(name => {
    const sorted = [...session.teams].sort(
      (a, b) => a.players.length - b.players.length
    );
    const t = sorted.find(x => x.players.length < 5);
    if (t) t.players.push(name);
  });

  bot.sendMessage(chatId, renderTeams(session));
});
