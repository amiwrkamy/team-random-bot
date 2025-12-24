const TelegramBot = require("node-telegram-bot-api");

const TOKEN = process.env.BOT_TOKEN || "YOUR_BOT_TOKEN";
const bot = new TelegramBot(TOKEN, { polling: true });

/* ================== STATE ================== */
const privateSessions = {};
const groupSessions = {};

/* ================== START ================== */
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  if (msg.chat.type === "private") {
    bot.sendMessage(chatId, "👇 حالت اجرا را انتخاب کن", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🤖 داخل ربات", callback_data: "inside_bot" }],
          [{ text: "👥 داخل گروه", callback_data: "inside_group" }]
        ]
      }
    });
  } else {
    sendTeamCount(chatId);
  }
});

/* ================== CALLBACK ================== */
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const data = q.data;

  // ⚠️ فقط answer، هیچ editMessageReplyMarkup نداریم
  bot.answerCallbackQuery(q.id);

  /* ---------- PRIVATE ---------- */
  if (data === "inside_bot") {
    privateSessions[chatId] = {};
    return sendTeamCount(chatId);
  }

  if (data === "inside_group") {
    const url = `https://t.me/${bot.username}?startgroup=true`;
    return bot.sendMessage(chatId, "➕ ربات را به گروه اضافه کن", {
      reply_markup: {
        inline_keyboard: [[{ text: "افزودن به گروه", url }]]
      }
    });
  }

  /* ---------- TEAM COUNT ---------- */
  if (data.startsWith("teams_")) {
    const teamCount = Number(data.split("_")[1]);

    if (q.message.chat.type === "private") {
      privateSessions[chatId] = {
        teams: teamCount,
        waitingNames: true
      };
      return bot.sendMessage(
        chatId,
        `✍️ اسامی را بفرست\n\nGoalkeepers:\nA\nB\n\nPlayers:\nC\nD`
      );
    }

    groupSessions[chatId] = {
      teams: teamCount,
      gks: [],
      players: [],
      open: true
    };

    return sendJoinButtons(chatId);
  }

  /* ---------- JOIN PLAYER ---------- */
  if (data === "join_player") {
    const s = groupSessions[chatId];
    if (!s || !s.open) return;

    if (isRegistered(s, userId)) {
      return alert(q, "❌ قبلاً ثبت شدی");
    }

    s.players.push({ id: userId, name: q.from.first_name });
    return alert(q, "✅ بازیکن ثبت شد");
  }

  /* ---------- JOIN GK ---------- */
  if (data === "join_gk") {
    const s = groupSessions[chatId];
    if (!s || !s.open) return;

    if (isRegistered(s, userId)) {
      return alert(q, "❌ قبلاً ثبت شدی");
    }

    if (s.gks.length >= s.teams) {
      return alert(q, "❌ گلرها تکمیل شدند");
    }

    s.gks.push({ id: userId, name: q.from.first_name });
    alert(q, "🧤 گلر ثبت شد");

    if (s.gks.length === s.teams) {
      s.open = false;
      buildTeams(chatId);
    }
  }

  /* ---------- RESHUFFLE ---------- */
  if (data === "reshuffle") {
    const admins = await bot.getChatAdministrators(chatId);
    if (!admins.find(a => a.user.id === userId)) {
      return alert(q, "❌ فقط ادمین");
    }
    buildTeams(chatId);
  }
});

/* ================== PRIVATE NAMES ================== */
bot.on("message", (msg) => {
  if (msg.chat.type !== "private") return;

  const s = privateSessions[msg.chat.id];
  if (!s || !s.waitingNames) return;

  const lines = msg.text.split("\n");
  let mode = null;
  const gks = [];
  const players = [];

  lines.forEach(l => {
    if (l.toLowerCase().startsWith("goalkeepers")) mode = "gk";
    else if (l.toLowerCase().startsWith("players")) mode = "p";
    else if (l.trim()) {
      if (mode === "gk") gks.push(l.trim());
      if (mode === "p") players.push(l.trim());
    }
  });

  if (gks.length < s.teams) {
    return bot.sendMessage(msg.chat.id, "❌ تعداد گلر کم است");
  }

  shuffle(gks);
  shuffle(players);

  const teams = Array.from({ length: s.teams }, (_, i) => [`🧤 ${gks[i]}`]);

  players.forEach((p, i) => {
    if (teams[i % s.teams].length < 5)
      teams[i % s.teams].push(`👟 ${p}`);
  });

  sendTeams(msg.chat.id, teams);
  s.waitingNames = false;
});

/* ================== HELPERS ================== */
function sendTeamCount(chatId) {
  bot.sendMessage(chatId, "⚽ چند تیم؟", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "۲ تیم", callback_data: "teams_2" }],
        [{ text: "۳ تیم", callback_data: "teams_3" }],
        [{ text: "۴ تیم", callback_data: "teams_4" }]
      ]
    }
  });
}

function sendJoinButtons(chatId) {
  bot.sendMessage(chatId, "🎯 نقش خود را انتخاب کن", {
    reply_markup: {
      inline_keyboard: [
        [
          { text: "⚽ بازیکن", callback_data: "join_player" },
          { text: "🧤 گلر", callback_data: "join_gk" }
        ],
        [{ text: "🔄 شانس دوباره (ادمین)", callback_data: "reshuffle" }]
      ]
    }
  });
}

function buildTeams(chatId) {
  const s = groupSessions[chatId];
  shuffle(s.players);
  shuffle(s.gks);

  const teams = Array.from({ length: s.teams }, (_, i) => [
    `🧤 ${s.gks[i].name}`
  ]);

  s.players.forEach((p, i) => {
    if (teams[i % s.teams].length < 5)
      teams[i % s.teams].push(`👟 ${p.name}`);
  });

  sendTeams(chatId, teams);
}

function sendTeams(chatId, teams) {
  let text = "🏆 تیم‌ها:\n\n";
  teams.forEach((t, i) => {
    text += `👥 تیم ${i + 1}\n${t.join("\n")}\n\n`;
  });
  bot.sendMessage(chatId, text);
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function isRegistered(s, id) {
  return s.players.some(p => p.id === id) || s.gks.some(g => g.id === id);
}

function alert(q, text) {
  bot.answerCallbackQuery(q.id, { text, show_alert: true });
        }
