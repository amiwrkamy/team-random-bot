// index.js
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

// ---------- config ----------
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("ERROR: BOT_TOKEN environment variable is required.");
  process.exit(1);
}
const PORT = process.env.PORT || 3000;

// ---------- bot init (polling) ----------
const bot = new TelegramBot(TOKEN, { polling: true });

// ---------- small web server for Render (keeps service healthy) ----------
const app = express();
app.get("/", (req, res) => res.send("Team-Chin Bot is running"));
app.listen(PORT, () => console.log(`Web server listening on ${PORT}`));

// ---------- In-memory games store ----------
const groupGames = Object.create(null); // key: chatId -> game object
// game structure:
// {
//   teamCount: 2|3,
//   teams: [ { gk: null, players: [], subs: [] }, ... ],
//   messageId: message_id_of_join_message,
//   users: { userId: { role: 'player'|'gk', name } }
// }

// ---------- small per-chat lock to avoid race conditions ----------
const locks = Object.create(null);
async function withLock(chatId, fn) {
  while (locks[chatId]) {
    // wait previous
    await locks[chatId];
  }
  let resolver;
  locks[chatId] = new Promise(res => resolver = res);
  try {
    return await fn();
  } finally {
    resolver();
    delete locks[chatId];
  }
}

// ---------- helpers ----------
function getDisplayName(user) {
  if (!user) return "کاربر";
  return user.username ? `@${user.username}` : (user.first_name || "کاربر");
}

function shuffleArray(arr) {
  // Fisher-Yates
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function initTeams(count) {
  return Array.from({ length: count }, () => ({ gk: null, players: [], subs: [] }));
}

function renderTeamsText(game) {
  let text = "🏆 وضعیت تیم‌ها (لایو)\n\n";
  game.teams.forEach((t, idx) => {
    const name = game.teamCount === 2 ? (idx === 0 ? "🔵 تیم آبی" : "🔥 تیم قرمز") : `🏆 تیم ${idx + 1}`;
    text += `${name}:\n`;
    text += `🧤 ${t.gk ?? "—"}\n`;
    t.players.forEach(p => text += `⚽ ${p}\n`);
    if (t.subs.length) {
      text += `🔄 تعویضی‌ها:\n`;
      t.subs.forEach(s => text += `▫️ ${s}\n`);
    }
    text += `\n`;
  });
  return text;
}

async function safeAnswerCallback(id) {
  try { await bot.answerCallbackQuery(id); } catch (e) { /* ignore */ }
}

// update group message: try edit, if fail (deleted) send new and update messageId
async function updateGroupMessage(chatId) {
  return withLock(chatId, async () => {
    const game = groupGames[chatId];
    if (!game) return;
    const text = renderTeamsText(game);
    const keyboard = {
      inline_keyboard: [
        [
          { text: "⚽ ثبت بازیکن", callback_data: "JOIN_PLAYER" },
          { text: "🧤 ثبت دروازه‌بان", callback_data: "JOIN_GK" }
        ],
        [{ text: "🔄 قاطی‌کردن دوباره (ادمین)", callback_data: "RESHUFFLE" }]
      ]
    };

    try {
      if (game.messageId) {
        await bot.editMessageText(text, {
          chat_id: chatId,
          message_id: game.messageId,
          reply_markup: keyboard
        });
      } else {
        const sent = await bot.sendMessage(chatId, text, { reply_markup: keyboard });
        game.messageId = sent.message_id;
      }
    } catch (err) {
      // if edit fails (message deleted or can't edit), send new & update messageId
      try {
        const sent = await bot.sendMessage(chatId, text, { reply_markup: keyboard });
        game.messageId = sent.message_id;
      } catch (e2) {
        console.error("Failed to update/send group message:", e2 && e2.message);
      }
    }
  });
}

// ---------- /start in private or group ----------
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const chatType = msg.chat.type;

  // Private: show MODE_PRIVATE and MODE_SEND_LINK
  if (chatType === "private") {
    const me = await bot.getMe();
    const link = `https://t.me/${me.username}?startgroup=teamchin`; // deep link for 'add to group'
    const keyboard = {
      inline_keyboard: [
        [{ text: "👤 داخل ربات", callback_data: "MODE_PRIVATE" }],
        [{ text: "👥 داخل گروه (ارسال لینک)", callback_data: "MODE_SEND_LINK" }]
      ]
    };
    return bot.sendMessage(chatId, `🏟 تیم‌چینی کجا انجام بشه؟\n\nبرای اضافه کردن به گروه از لینک استفاده کنید:`, { reply_markup: keyboard });
  }

  // Group: hint to use /start_team
  // If bot not admin or permissions missing, warn
  return bot.sendMessage(chatId, "برای شروع تیم‌چینی در این گروه دستور زیر را اجرا کنید:\n\n/start_team\n(یا اگر ربات را خودتان به گروه اضافه کرده‌اید، ادمین /start_team را اجرا کند)");
});

// ---------- /start_team: show 2 or 3 teams in group ----------
bot.onText(/\/start_team/, async (msg) => {
  const chatId = msg.chat.id;
  if (msg.chat.type === "private") {
    return bot.sendMessage(chatId, "این دستور را داخل گروه اجرا کنید.");
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: "🔵 ۲ تیم", callback_data: "GROUP_TEAMS_2" }],
      [{ text: "🟢 ۳ تیم", callback_data: "GROUP_TEAMS_3" }]
    ]
  };
  await bot.sendMessage(chatId, "🧮 چند تیم می‌خوای؟", { reply_markup: keyboard });
});

// ---------- callback_query handler ----------
bot.on('callback_query', async (q) => {
  const data = q.data;
  const from = q.from;
  const message = q.message;
  const chatId = message && message.chat && message.chat.id;

  // Always answer quickly to avoid "query is too old"
  await safeAnswerCallback(q.id);

  try {
    // PRIVATE MODE: ask team count
    if (data === "MODE_PRIVATE") {
      await bot.sendMessage(chatId, "🧮 چند تیم می‌خوای؟", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔵 ۲ تیم", callback_data: "PRIVATE_TEAMS_2" }],
            [{ text: "🟢 ۳ تیم", callback_data: "PRIVATE_TEAMS_3" }]
          ]
        }
      });
      return;
    }

    // SEND LINK for group
    if (data === "MODE_SEND_LINK") {
      const me = await bot.getMe();
      const link = `https://t.me/${me.username}?startgroup=teamchin`;
      await bot.sendMessage(chatId, `👥 برای اضافه کردن ربات به گروه روی لینک بزن و سپس در گروه /start_team را اجرا کن:\n\n${link}`);
      return;
    }

    // PRIVATE teams chosen -> mark session for private chat
    if (data === "PRIVATE_TEAMS_2" || data === "PRIVATE_TEAMS_3") {
      const count = data.endsWith("2") ? 2 : 3;
      // store in groupGames keyed by private chat id but as privateMode
      groupGames[chatId] = { privateMode: true, teamCount: count };
      await bot.sendMessage(chatId, "✍️ لطفاً اسم بازیکن‌ها را با فاصله بفرست (مثال: Ali Reza Sara).");
      return;
    }

    // GROUP: team count selection after /start_team
    if (data === "GROUP_TEAMS_2" || data === "GROUP_TEAMS_3") {
      const count = data.endsWith("2") ? 2 : 3;
      const gchat = message.chat.id;

      // init game
      groupGames[gchat] = {
        teamCount: count,
        teams: initTeams(count),
        messageId: null,
        users: {} // userId -> { role, name }
      };

      const keyboard = {
        inline_keyboard: [
          [
            { text: "⚽ ثبت بازیکن", callback_data: "JOIN_PLAYER" },
            { text: "🧤 ثبت دروازه‌بان", callback_data: "JOIN_GK" }
          ],
          [{ text: "🔄 قاطی‌کردن دوباره (ادمین)", callback_data: "RESHUFFLE" }]
        ]
      };

      const sent = await bot.sendMessage(gchat, "🏆 تیم‌چینی شروع شد!\nنقش خودتو انتخاب کن 👇", { reply_markup: keyboard });
      groupGames[gchat].messageId = sent.message_id;
      return;
    }

    // JOIN_PLAYER in group
    if (data === "JOIN_PLAYER") {
      const gchat = message.chat.id;
      if (!groupGames[gchat]) return;
      await withLock(gchat, async () => {
        const game = groupGames[gchat];
        const uid = from.id;
        const name = getDisplayName(from);

        if (game.users[uid]) {
          // already registered
          await bot.sendMessage(gchat, `${name} قبلاً ثبت شده است.`, { reply_to_message_id: message.message_id });
          return;
        }

        // choose team randomly among those with <4 players
        const available = game.teams.filter(t => t.players.length < 4);
        if (available.length > 0) {
          shuffleArray(available);
          available[0].players.push(name);
        } else {
          // all teams full -> go to subs (random team)
          shuffleArray(game.teams);
          game.teams[0].subs.push(name);
        }

        game.users[uid] = { role: "player", name };
        await updateGroupMessage(gchat);
      });
      return;
    }

    // JOIN_GK in group
    if (data === "JOIN_GK") {
      const gchat = message.chat.id;
      if (!groupGames[gchat]) return;
      await withLock(gchat, async () => {
        const game = groupGames[gchat];
        const uid = from.id;
        const name = getDisplayName(from);

        if (game.users[uid]) {
          await bot.sendMessage(gchat, `${name} قبلاً ثبت شده است.`, { reply_to_message_id: message.message_id });
          return;
        }

        const free = game.teams.filter(t => !t.gk);
        if (free.length === 0) {
          await bot.sendMessage(gchat, "همه تیم‌ها دروازه‌بان دارند ❌", { reply_to_message_id: message.message_id });
          return;
        }

        shuffleArray(free);
        free[0].gk = name;
        game.users[uid] = { role: "gk", name };
        await updateGroupMessage(gchat);
      });
      return;
    }

    // RESHUFFLE (admin only)
    if (data === "RESHUFFLE") {
      const gchat = message.chat.id;
      const game = groupGames[gchat];
      if (!game) return;
      // check admin
      let isAdmin = false;
      try {
        const member = await bot.getChatMember(gchat, from.id);
        if (member && (member.status === "administrator" || member.status === "creator")) isAdmin = true;
      } catch (e) { /* ignore */ }

      if (!isAdmin) {
        await bot.sendMessage(gchat, "⛔ فقط ادمین می‌تواند این کار را انجام دهد.");
        return;
      }

      await withLock(gchat, async () => {
        // collect all names
        const gks = [];
        const players = [];
        Object.values(game.teams).forEach(t => {
          if (t.gk) gks.push(t.gk);
          players.push(...t.players, ...t.subs);
          t.gk = null; t.players = []; t.subs = [];
        });

        shuffleArray(gks);
        shuffleArray(players);

        gks.forEach((gk, i) => {
          if (game.teams[i]) game.teams[i].gk = gk;
        });

        players.forEach(p => {
          const available = game.teams.filter(t => t.players.length < 4);
          if (available.length > 0) {
            shuffleArray(available);
            available[0].players.push(p);
          } else {
            shuffleArray(game.teams);
            game.teams[0].subs.push(p);
          }
        });

        await updateGroupMessage(gchat);
      });
      return;
    }

  } catch (err) {
    console.error("callback_query error:", err && err.message);
  }
});

// ---------- private names handler after PRIVATE_TEAMS_X ----------
bot.on('message', async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const sess = groupGames[chatId];
  if (sess && sess.privateMode && sess.teamCount) {
    // user sent names in private
    const tokens = msg.text.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
      return bot.sendMessage(chatId, "هیچ اسمی یافت نشد، لطفاً اسم‌ها را با فاصله ارسال کن.");
    }
    shuffleArray(tokens);
    const teams = Array.from({ length: sess.teamCount }, () => []);
    tokens.forEach((n, i) => teams[i % sess.teamCount].push(n));
    let out = "🏆 نتیجه تیم‌بندی (پی‌وی):\n\n";
    teams.forEach((t, i) => {
      out += `🔥 تیم ${i + 1}:\n`;
      t.forEach(x => out += `⚽ ${x}\n`);
      out += "\n";
    });
    // cleanup
    delete groupGames[chatId];
    return bot.sendMessage(chatId, out);
  }
});

// ---------- global error handlers to avoid crash ----------
process.on('uncaughtException', (err) => {
  console.error('uncaughtException:', err && err.stack || err);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});

console.log("Bot started, polling...");
