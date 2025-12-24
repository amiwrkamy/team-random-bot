import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ Please set BOT_TOKEN environment variable");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
console.log("🔁 Bot started polling...");

/* ================== State ================== */
/*
 groups: {
   [chatId]: {
     teams: number,
     players: [{id, name}],
     gks: [{id, name}],
     messageId: number, // status message id (lives)
     signupOpen: true/false
   }
 }
 privateSessions: {
   [chatId]: { teams, awaitingNames: bool }
 }
*/
const groups = {};
const privateSessions = {};

/* ================== Helpers ================== */
const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);

function ensureGroup(chatId) {
  if (!groups[chatId]) {
    groups[chatId] = {
      teams: 0,
      players: [],
      gks: [],
      messageId: null,
      signupOpen: false
    };
  }
  return groups[chatId];
}

function buildKeyboardForGroup() {
  return {
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
}

/* ================== Update & Render Teams ================== */
async function renderGroupStatus(chatId) {
  const g = groups[chatId];
  if (!g) return;

  // create shallow copies and shuffle for randomness
  const gks = shuffle([...g.gks]);
  const players = shuffle([...g.players]);

  // initialize teams
  const teamCount = Math.max(0, g.teams);
  const teams = Array.from({ length: teamCount }, () => []);

  // assign gk placeholders if not enough
  for (let i = 0; i < teamCount; i++) {
    if (gks[i]) teams[i].push(`🧤 ${gks[i].name}`);
    else teams[i].push(`🧤 —`); // placeholder until GK registers
  }

  // round-robin assign players while max 5 per team (including GK)
  const extras = [];
  let idx = 0;
  for (const p of players) {
    // find next team that has <5 (including GK placeholder)
    // attempt up to teamCount times to keep balance
    let attempts = 0;
    let placed = false;
    while (attempts < teamCount) {
      const ti = (idx + attempts) % teamCount;
      if (teams[ti].length < 5) {
        teams[ti].push(`⚽ ${p.name}`);
        placed = true;
        break;
      }
      attempts++;
    }
    if (!placed) extras.push(p.name);
    idx++;
  }

  // ensure difference between teams isn't huge (we already round-robin)
  // build text
  let text = "🏆 وضعیت تیم‌ها (لایو)\n\n";
  for (let i = 0; i < teamCount; i++) {
    const t = teams[i];
    text += `🔵 تیم ${i + 1} — ${Math.max(0, t.length)} نفر\n`;
    for (const line of t) text += ` ${line}\n`;
    text += `\n`;
  }
  if (extras.length > 0) {
    text += `🔄 تعویضی‌ها: ${extras.join(", ")}\n\n`;
  } else {
    text += `🔄 تعویضی‌ها: —\n\n`;
  }

  text += "📌 هر نفر فقط یک‌بار می‌تواند ثبت‌نام کند.\n";
  text += "👑 فقط ادمین می‌تواند «🔀 قاطی‌کردن دوباره» را اجرا کند.\n";

  const opts = {
    chat_id: chatId,
    message_id: g.messageId,
    reply_markup: buildKeyboardForGroup()
  };

  try {
    if (g.messageId) {
      await bot.editMessageText(text, opts);
    } else {
      const sent = await bot.sendMessage(chatId, text, { reply_markup: buildKeyboardForGroup() });
      g.messageId = sent.message_id;
    }
  } catch (err) {
    // message might have been deleted or changed; try sending fresh
    try {
      const sent = await bot.sendMessage(chatId, text, { reply_markup: buildKeyboardForGroup() });
      g.messageId = sent.message_id;
    } catch (e) {
      console.error("❌ Failed to send/edit group status:", e.toString());
    }
  }
}

/* ================== /start in private ================== */
bot.onText(/^\/start$/, async (msg) => {
  try {
    if (msg.chat.type !== "private") return;
    await bot.sendMessage(msg.chat.id, "سلام! حالت مورد نظر را انتخاب کن:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🤖 داخل ربات", callback_data: "MODE_PRIVATE" }],
          [{ text: "👥 داخل گروه", callback_data: "MODE_GROUP" }]
        ]
      }
    });
  } catch (e) {
    console.error(e);
  }
});

/* ================== /start_team in group (shortcut) ================== */
bot.onText(/^\/start_team$/, async (msg) => {
  try {
    if (msg.chat.type === "private") return;
    // prompt team count
    await bot.sendMessage(msg.chat.id, "🔢 تعداد تیم‌ها را انتخاب کنید:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "۲ تیم ⚽", callback_data: "TEAMS_2" }],
          [{ text: "۳ تیم ⚽", callback_data: "TEAMS_3" }],
          [{ text: "۴ تیم ⚽", callback_data: "TEAMS_4" }]
        ]
      }
    });
  } catch (e) {
    console.error(e);
  }
});

/* ================== Callback queries ================== */
bot.on("callback_query", async (q) => {
  const data = q.data;
  const chatId = q.message.chat.id;
  const user = q.from;

  try {
    // MODE selection (private)
    if (data === "MODE_PRIVATE") {
      await bot.answerCallbackQuery(q.id);
      // send team-count choices in private
      await bot.sendMessage(chatId, "🔢 چند تیم می‌خوای؟", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "۲ تیم ⚽", callback_data: "PRIV_TEAMS_2" }],
            [{ text: "۳ تیم ⚽", callback_data: "PRIV_TEAMS_3" }],
            [{ text: "۴ تیم ⚽", callback_data: "PRIV_TEAMS_4" }]
          ]
        }
      });
      return;
    }

    if (data === "MODE_GROUP") {
      await bot.answerCallbackQuery(q.id);
      // send link to add bot to group
      const botUsername = (await bot.getMe()).username;
      const url = `https://t.me/${botUsername}?startgroup=true`;
      await bot.sendMessage(chatId, `برای اضافه کردن ربات به گروه روی لینک بزن:\n${url}`);
      return;
    }

    // PRIVATE TEAM COUNT selection
    if (data && data.startsWith("PRIV_TEAMS_")) {
      await bot.answerCallbackQuery(q.id);
      const num = Number(data.split("_")[2]);
      privateSessions[chatId] = { teams: num, awaitingNames: true };
      await bot.sendMessage(chatId,
        "👌 خوب! حالا لطفاً لیست نام‌ها را ارسال کن.\n\nفرمت پیشنهادی:\nGoalkeepers:\nAli\nSara\nPlayers:\nReza\nMohammad\n...\n\n(یا فقط نام‌ها را مرحله‌ای بفرست؛ من سعی می‌کنم تشخیص بدم.)"
      );
      return;
    }

    // GROUP team count chosen
    if (data && data.startsWith("TEAMS_")) {
      await bot.answerCallbackQuery(q.id);
      const num = Number(data.split("_")[1]);
      const g = ensureGroup(chatId);
      g.teams = num;
      g.players = [];
      g.gks = [];
      g.signupOpen = true;
      // send initial live status message and buttons
      const sent = await bot.sendMessage(chatId, `🏁 تیم‌چینی شروع شد — ${num} تیم\n\nدر نقش بازیکن یا دروازه‌بان ثبت‌نام کنید.`, {
        reply_markup: buildKeyboardForGroup()
      });
      g.messageId = sent.message_id;
      // render status (will edit the message we just sent)
      await renderGroupStatus(chatId);
      return;
    }

    // JOIN PLAYER
    if (data === "JOIN_PLAYER") {
      await bot.answerCallbackQuery(q.id, { text: "درحال ثبت به عنوان بازیکن..." });
      const g = ensureGroup(chatId);
      if (!g.signupOpen) return bot.answerCallbackQuery(q.id, { text: "ثبت‌نام بسته است", show_alert: true });

      // check already registered
      if (g.players.some(p => p.id === user.id) || g.gks.some(p => p.id === user.id)) {
        return bot.answerCallbackQuery(q.id, { text: "شما قبلاً ثبت شده‌اید", show_alert: true });
      }
      g.players.push({ id: user.id, name: user.first_name || user.username });
      await renderGroupStatus(chatId);
      return;
    }

    // JOIN GK
    if (data === "JOIN_GK") {
      await bot.answerCallbackQuery(q.id, { text: "درحال ثبت به عنوان دروازه‌بان..." });
      const g = ensureGroup(chatId);
      if (!g.signupOpen) return bot.answerCallbackQuery(q.id, { text: "ثبت‌نام بسته است", show_alert: true });

      if (g.players.some(p => p.id === user.id) || g.gks.some(p => p.id === user.id)) {
        return bot.answerCallbackQuery(q.id, { text: "شما قبلاً ثبت شده‌اید", show_alert: true });
      }
      if (g.gks.length >= g.teams) {
        return bot.answerCallbackQuery(q.id, { text: "تعداد دروازه‌بان‌ها کامل است", show_alert: true });
      }
      g.gks.push({ id: user.id, name: user.first_name || user.username });
      await renderGroupStatus(chatId);
      return;
    }

    // RESHUFFLE (only admin)
    if (data === "RESHUFFLE") {
      await bot.answerCallbackQuery(q.id);
      const g = ensureGroup(chatId);
      // check admin
      const admins = await bot.getChatAdministrators(chatId);
      const isAdmin = admins.some(a => a.user.id === user.id);
      if (!isAdmin) return bot.answerCallbackQuery(q.id, { text: "⛔ فقط ادمین", show_alert: true });
      // reshuffle: just re-render (shuffles in render)
      await renderGroupStatus(chatId);
      await bot.answerCallbackQuery(q.id, { text: "🔀 اسامی دوباره قرعه‌کشی شد" });
      return;
    }

    // default
    await bot.answerCallbackQuery(q.id);
  } catch (err) {
    console.error("callback error:", err);
    try { await bot.answerCallbackQuery(q.id, { text: "❌ خطا، دوباره تلاش کن", show_alert: true }); } catch {}
  }
});

/* ================== Private messages handling (names input) ================== */
bot.on("message", async (msg) => {
  try {
    // handle only private messages for names (ignore commands here)
    if (msg.chat.type !== "private") return;
    if (!msg.text) return;

    const sess = privateSessions[msg.chat.id];
    if (!sess || !sess.awaitingNames) return;

    const raw = msg.text.trim();
    // parse simple format:
    // find Goalkeepers: ... Players: ...
    const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(l => l.length);
    let mode = "players"; // default
    const gk_names = [];
    const player_names = [];
    for (let ln of lines) {
      const low = ln.toLowerCase();
      if (low.startsWith("goalkeeper") || low.startsWith("gk:") || low.startsWith("گلر") || low.startsWith("goalkeepers")) {
        mode = "gk";
        continue;
      }
      if (low.startsWith("player") || low.startsWith("players:") || low.startsWith("بازیکن") || low.startsWith("players")) {
        mode = "players";
        continue;
      }
      // if line contains commas, split
      const parts = ln.split(",").map(p => p.trim()).filter(Boolean);
      if (parts.length > 1) {
        for (const p of parts) {
          (mode === "gk" ? gk_names : player_names).push(p);
        }
      } else {
        (mode === "gk" ? gk_names : player_names).push(ln);
      }
    }

    // fallback: if no explicit GK lines, assume first N names are players (and system chooses GK randomly)
    const teamsCount = sess.teams || 2;
    // If not enough GK names, we will pick randomly from player_names to be GK to reach teamsCount
    if (gk_names.length < teamsCount && player_names.length >= teamsCount) {
      // pick some to be GK
      while (gk_names.length < teamsCount && player_names.length > 0) {
        const pick = player_names.splice(Math.floor(Math.random() * player_names.length), 1)[0];
        gk_names.push(pick);
      }
    }

    if (gk_names.length < teamsCount) {
      await bot.sendMessage(msg.chat.id, `❌ تعداد گلرها کمتر از تعداد تیم‌ها (${teamsCount}) است. لطفاً لیست را دوباره ارسال کن یا حداقل ${teamsCount} گلر مشخص کن.`);
      return;
    }

    // shuffle and distribute
    const gksh = shuffle(gk_names.slice(0, teamsCount));
    const playersSh = shuffle(player_names);

    const teams = Array.from({ length: teamsCount }, () => []);
    for (let i = 0; i < teamsCount; i++) {
      teams[i].push(`🧤 ${gksh[i]}`);
    }
    let idx = 0;
    const extras = [];
    for (const p of playersSh) {
      const ti = idx % teamsCount;
      if (teams[ti].length < 5) teams[ti].push(`⚽ ${p}`);
      else extras.push(p);
      idx++;
    }

    let text = "🏆 نتیجه تیم‌بندی (داخل ربات)\n\n";
    teams.forEach((t, i) => {
      text += `🔵 تیم ${i + 1} — ${t.length} نفر\n`;
      t.forEach(line => text += ` ${line}\n`);
      text += `\n`;
    });
    if (extras.length) text += `🔄 تعویضی‌ها: ${extras.join(", ")}\n`;

    await bot.sendMessage(msg.chat.id, text);
    sess.awaitingNames = false;
    delete privateSessions[msg.chat.id];
  } catch (err) {
    console.error("private message error:", err);
  }
});

/* ================== Graceful log ================== */
bot.on("polling_error", (err) => {
  console.error("Polling error:", err);
});
