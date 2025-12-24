import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ BOT_TOKEN not set");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
console.log("✅ BOT RUNNING");

// -------------------- STATE --------------------
const groupState = new Map();
// chatId => {
//   teamsCount,
//   players: Map(userId => {name, role}),
//   messageId
// }

// -------------------- HELPERS --------------------
function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

function buildTeams(state) {
  const goalkeepers = [];
  const players = [];

  for (const p of state.players.values()) {
    if (p.role === "gk") goalkeepers.push(p.name);
    else players.push(p.name);
  }

  const teams = Array.from({ length: state.teamsCount }, () => []);

  shuffle(goalkeepers);
  shuffle(players);

  // assign one GK per team
  for (let i = 0; i < teams.length; i++) {
    if (goalkeepers[i]) teams[i].push("🧤 " + goalkeepers[i]);
  }

  let i = 0;
  for (const pl of players) {
    const t = i % teams.length;
    if (teams[t].length < 5) {
      teams[t].push("⚽ " + pl);
    }
    i++;
  }

  return teams;
}

function renderText(state) {
  const teams = buildTeams(state);
  let text = "🏆 وضعیت تیم‌ها (لایو)\n\n";

  teams.forEach((t, i) => {
    text += `🔵 تیم ${i + 1} — ${t.length} نفر\n`;
    text += t.length ? t.join("\n") : "—";
    text += "\n\n";
  });

  text += "📌 هر نفر فقط یک‌بار می‌تواند ثبت‌نام کند.\n";
  text += "👑 فقط ادمین می‌تواند 🔀 قاطی‌کردن را بزند.";

  return text;
}

function keyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⚽ بازیکن", callback_data: "join_player" },
        { text: "🧤 دروازه‌بان", callback_data: "join_gk" }
      ],
      [{ text: "🔀 قاطی‌کردن (ادمین)", callback_data: "reshuffle" }]
    ]
  };
}

// -------------------- START --------------------
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🎯 حالت را انتخاب کن",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🤖 داخل ربات", callback_data: "mode_private" }],
          [{ text: "👥 داخل گروه", callback_data: "mode_group" }]
        ]
      }
    }
  );
});

// -------------------- CALLBACKS --------------------
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const name = q.from.first_name;

  // -------- MODE GROUP --------
  if (q.data === "mode_group") {
    return bot.answerCallbackQuery(q.id, {
      text: "ربات را به گروه اضافه کن و /start بزن"
    });
  }

  // -------- TEAM COUNT --------
  if (["2", "3", "4"].includes(q.data)) {
    groupState.set(chatId, {
      teamsCount: Number(q.data),
      players: new Map(),
      messageId: null
    });

    const sent = await bot.sendMessage(
      chatId,
      "🎯 نقش خود را انتخاب کن",
      { reply_markup: keyboard() }
    );

    groupState.get(chatId).messageId = sent.message_id;
    return bot.answerCallbackQuery(q.id);
  }

  const state = groupState.get(chatId);
  if (!state) return bot.answerCallbackQuery(q.id);

  // -------- JOIN PLAYER --------
  if (q.data === "join_player" || q.data === "join_gk") {
    if (state.players.has(userId)) {
      return bot.answerCallbackQuery(q.id, {
        text: "قبلاً ثبت‌نام کرده‌ای ❌",
        show_alert: true
      });
    }

    state.players.set(userId, {
      name,
      role: q.data === "join_gk" ? "gk" : "player"
    });

    await bot.editMessageText(
      renderText(state),
      {
        chat_id: chatId,
        message_id: state.messageId,
        reply_markup: keyboard()
      }
    );

    return bot.answerCallbackQuery(q.id, { text: "ثبت شد ✅" });
  }

  // -------- RESHUFFLE --------
  if (q.data === "reshuffle") {
    const admins = await bot.getChatAdministrators(chatId);
    if (!admins.some(a => a.user.id === userId)) {
      return bot.answerCallbackQuery(q.id, {
        text: "فقط ادمین ❌",
        show_alert: true
      });
    }

    await bot.editMessageText(
      renderText(state),
      {
        chat_id: chatId,
        message_id: state.messageId,
        reply_markup: keyboard()
      }
    );

    return bot.answerCallbackQuery(q.id, { text: "قاطی شد 🔀" });
  }
});

// -------------------- TEAM COUNT BUTTONS --------------------
bot.on("message", (msg) => {
  if (msg.text === "/start_team") {
    bot.sendMessage(msg.chat.id, "🔢 تعداد تیم‌ها را انتخاب کن", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "۲ تیم", callback_data: "2" }],
          [{ text: "۳ تیم", callback_data: "3" }],
          [{ text: "۴ تیم", callback_data: "4" }]
        ]
      }
    });
  }
});
