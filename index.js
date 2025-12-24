require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

console.log("✅ Bot is running...");

// ================== STATE ==================
const groups = {}; // chatId => state

function initGroup(chatId, adminId) {
  groups[chatId] = {
    adminId,
    teamCount: 2,
    players: {}, // userId => {name, role}
    teams: [],
    subs: []
  };
}

// ================== HELPERS ==================
function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

function buildTeams(state) {
  const goalkeepers = [];
  const players = [];

  Object.values(state.players).forEach(p => {
    if (p.role === "gk") goalkeepers.push(p);
    else players.push(p);
  });

  state.teams = Array.from({ length: state.teamCount }, (_, i) => ({
    name: `🔵 تیم ${i + 1}`,
    gk: null,
    members: []
  }));
  state.subs = [];

  shuffle(goalkeepers);
  shuffle(players);

  // assign goalkeepers (max 1 per team)
  state.teams.forEach(team => {
    if (goalkeepers.length) team.gk = goalkeepers.pop();
  });

  // assign players max 5 per team
  for (const p of players) {
    const team = state.teams
      .filter(t => t.members.length < 4)
      .sort((a, b) => a.members.length - b.members.length)[0];

    if (team) team.members.push(p);
    else state.subs.push(p);
  }
}

function renderTeams(state) {
  let text = "🏆 وضعیت تیم‌ها (لایو)\n\n";
  state.teams.forEach(t => {
    text += `${t.name}\n`;
    text += t.gk ? `🧤 ${t.gk.name}\n` : "🧤 ندارد\n";
    t.members.forEach(m => (text += `⚽ ${m.name}\n`));
    text += "\n";
  });

  if (state.subs.length) {
    text += "🔄 تعویضی‌ها:\n";
    state.subs.forEach(s => (text += `➖ ${s.name}\n`));
  }

  text += "\n📌 هر نفر فقط یک‌بار می‌تواند ثبت‌نام کند.";
  text += "\n👑 فقط ادمین می‌تواند 🔀 قاطی‌کردن دوباره را بزند.";

  return text;
}

// ================== START ==================
bot.onText(/\/start/, msg => {
  bot.sendMessage(msg.chat.id, "🎮 انتخاب کن:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🤖 داخل ربات", callback_data: "private" }],
        [{ text: "👥 داخل گروه", callback_data: "group" }]
      ]
    }
  });
});

// ================== CALLBACK ==================
bot.on("callback_query", q => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const data = q.data;

  // inside group
  if (data === "group") {
    bot.sendMessage(chatId, "➕ بات را به گروه اضافه کن و /start_team بزن");
    return;
  }

  // private flow
  if (data === "private") {
    bot.sendMessage(chatId, "🔢 تعداد تیم‌ها:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "2️⃣", callback_data: "t_2" }],
          [{ text: "3️⃣", callback_data: "t_3" }],
          [{ text: "4️⃣", callback_data: "t_4" }]
        ]
      }
    });
    return;
  }

  // team count
  if (data.startsWith("t_")) {
    bot.sendMessage(chatId, "✍️ اسم‌ها رو هر خط جدا بفرست");
    return;
  }

  // role selection
  if (data === "player" || data === "gk") {
    const state = groups[chatId];
    if (!state || state.players[userId]) return;

    state.players[userId] = {
      name: q.from.first_name,
      role: data === "gk" ? "gk" : "player"
    };

    buildTeams(state);

    bot.editMessageText(renderTeams(state), {
      chat_id: chatId,
      message_id: q.message.message_id,
      reply_markup: {
        inline_keyboard: [
          [
            { text: "⚽ بازیکن", callback_data: "player" },
            { text: "🧤 دروازه‌بان", callback_data: "gk" }
          ],
          [{ text: "🔀 قاطی‌کردن دوباره", callback_data: "reshuffle" }]
        ]
      }
    });
  }

  // reshuffle
  if (data === "reshuffle") {
    const state = groups[chatId];
    if (!state || state.adminId !== userId) return;

    buildTeams(state);

    bot.editMessageText(renderTeams(state), {
      chat_id: chatId,
      message_id: q.message.message_id,
      reply_markup: q.message.reply_markup
    });
  }
});

// ================== GROUP START ==================
bot.onText(/\/start_team/, msg => {
  if (msg.chat.type === "private") return;

  initGroup(msg.chat.id, msg.from.id);

  bot.sendMessage(msg.chat.id, "🔢 تعداد تیم‌ها:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "2️⃣", callback_data: "t_2" }],
        [{ text: "3️⃣", callback_data: "t_3" }],
        [{ text: "4️⃣", callback_data: "t_4" }]
      ]
    }
  });
});

// ================== TEXT (PRIVATE NAMES) ==================
bot.on("message", msg => {
  if (msg.chat.type !== "private") return;
  if (!msg.text || msg.text.startsWith("/")) return;

  const names = msg.text.split("\n").map(t => t.trim()).filter(Boolean);
  if (!names.length) return;

  const shuffled = shuffle(names);
  let out = "🎲 قرعه‌کشی:\n\n";
  shuffled.forEach((n, i) => (out += `${i + 1}. ${n}\n`));

  bot.sendMessage(msg.chat.id, out);
});
