import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN || "YOUR_BOT_TOKEN";
const bot = new TelegramBot(TOKEN, { polling: true });

/*
sessions[groupId] = {
  teamsCount: 2|3|4,
  players: Map(userId => {name, role}),
  messageId: number
}
*/
const sessions = {};

// ---------- helpers ----------
function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

function buildKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "⚽ بازیکن", callback_data: "join_player" },
        { text: "🥅 دروازه‌بان", callback_data: "join_gk" }
      ],
      [
        { text: "🔀 قاطی‌کردن دوباره (ادمین)", callback_data: "reshuffle" }
      ]
    ]
  };
}

function renderTeams(session) {
  const players = [...session.players.values()];
  const gks = players.filter(p => p.role === "gk");
  const field = players.filter(p => p.role === "player");

  if (gks.length < session.teamsCount) {
    return "⛔ هنوز به تعداد کافی دروازه‌بان ثبت نشده است.";
  }

  shuffle(gks);
  shuffle(field);

  const teams = Array.from({ length: session.teamsCount }, () => []);

  // assign GK
  for (let i = 0; i < session.teamsCount; i++) {
    teams[i].push(`🥅 ${gks[i].name}`);
  }

  // assign players (max 5 نفر)
  let i = 0;
  for (const p of field) {
    const idx = i % session.teamsCount;
    if (teams[idx].length < 5) {
      teams[idx].push(`⚽ ${p.name}`);
    }
    i++;
  }

  let text = "🏆 وضعیت تیم‌ها (لایو)\n\n";
  teams.forEach((t, i) => {
    text += `🔵 تیم ${i + 1} — ${t.length} نفر\n`;
    text += t.map(x => `  ${x}`).join("\n") + "\n\n";
  });

  text += "📌 هر نفر فقط یک‌بار می‌تواند ثبت‌نام کند.\n";
  text += "👑 فقط ادمین می‌تواند «🔀 قاطی‌کردن دوباره» را اجرا کند.";

  return text;
}

// ---------- start ----------
bot.onText(/\/start/, async msg => {
  if (msg.chat.type === "private") {
    bot.sendMessage(
      msg.chat.id,
      "👥 ربات را به گروه اضافه کن و داخل گروه /start بزن"
    );
    return;
  }

  bot.sendMessage(msg.chat.id, "🔢 تعداد تیم‌ها را انتخاب کن:", {
    inline_keyboard: [
      [{ text: "۲ تیم", callback_data: "teams_2" }],
      [{ text: "۳ تیم", callback_data: "teams_3" }],
      [{ text: "۴ تیم", callback_data: "teams_4" }]
    ]
  });
});

// ---------- callbacks ----------
bot.on("callback_query", async q => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const name = q.from.first_name || "Player";

  // انتخاب تعداد تیم
  if (q.data.startsWith("teams_")) {
    const count = Number(q.data.split("_")[1]);

    sessions[chatId] = {
      teamsCount: count,
      players: new Map(),
      messageId: null
    };

    const sent = await bot.sendMessage(
      chatId,
      "🎯 نقش خود را انتخاب کن",
      { reply_markup: buildKeyboard() }
    );

    sessions[chatId].messageId = sent.message_id;
    return bot.answerCallbackQuery(q.id);
  }

  const session = sessions[chatId];
  if (!session) return bot.answerCallbackQuery(q.id);

  // ثبت بازیکن
  if (q.data === "join_player" || q.data === "join_gk") {
    if (session.players.has(userId)) {
      return bot.answerCallbackQuery(q.id, {
        text: "⛔ قبلاً ثبت‌نام کرده‌ای",
        show_alert: true
      });
    }

    session.players.set(userId, {
      name,
      role: q.data === "join_gk" ? "gk" : "player"
    });

    const text = renderTeams(session);
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: session.messageId,
      reply_markup: buildKeyboard()
    });

    return bot.answerCallbackQuery(q.id, {
      text: "✅ ثبت شد",
      show_alert: false
    });
  }

  // reshuffle (admin only)
  if (q.data === "reshuffle") {
    const admins = await bot.getChatAdministrators(chatId);
    const isAdmin = admins.some(a => a.user.id === userId);

    if (!isAdmin) {
      return bot.answerCallbackQuery(q.id, {
        text: "❌ فقط ادمین",
        show_alert: true
      });
    }

    const text = renderTeams(session);
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: session.messageId,
      reply_markup: buildKeyboard()
    });

    return bot.answerCallbackQuery(q.id, { text: "🔀 انجام شد" });
  }
});
