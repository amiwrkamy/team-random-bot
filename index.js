// index.js
// Advanced Team-Chin bot (Telegraf + Express) - Random, live, admin-controlled

const { Telegraf, Markup } = require("telegraf");
const express = require("express");
const crypto = require("crypto");

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("Missing BOT_TOKEN env var");
  process.exit(1);
}
const bot = new Telegraf(TOKEN);

// tiny web server (Render Web Service expects a listening port)
const app = express();
app.get("/", (req, res) => res.send("teamchin bot alive"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Web server listening on", PORT));

// ---------- Helpers ----------
function displayName(user) {
  if (!user) return "کاربر";
  return user.username ? `@${user.username}` : (user.first_name || "کاربر");
}

// secure Fisher-Yates shuffle using crypto.randomInt
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// safe random choice
function randomChoice(arr) {
  if (!arr || arr.length === 0) return null;
  const idx = crypto.randomInt(arr.length);
  return arr[idx];
}

// small sleep
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// per-chat mutex to avoid race conditions
const locks = new Map();
async function withLock(chatId, fn) {
  while (locks.get(chatId)) {
    await wait(10);
  }
  locks.set(chatId, true);
  try {
    return await fn();
  } finally {
    locks.delete(chatId);
  }
}

// ---------- In-memory state (one game per group) ----------
/*
  games[chatId] = {
    teamCount: n,
    teams: [ { gk: null, players: [], subs: [] }, ... ],
    users: { userId: { name, role: 'player'|'gk' } },
    messageId: message_id_of_join_message
  }
*/
const games = Object.create(null);

// ---------- Utilities: render team text and keyboard ----------
function renderTeamsText(game) {
  if (!game) return "هیچ بازی‌ای فعال نیست.";
  let text = "🏆 وضعیت تیم‌ها (لایو)\n\n";
  game.teams.forEach((t, i) => {
    const header = game.teamCount === 2 ? (i === 0 ? "🔵 تیم آبی" : "🔥 تیم قرمز") : `🏷 تیم ${i + 1}`;
    text += `${header}:\n`;
    text += `🧤 ${t.gk ?? "—"}\n`;
    t.players.forEach((p) => (text += `⚽ ${p}\n`));
    if (t.subs.length) {
      text += `🔄 تعویضی‌ها:\n`;
      t.subs.forEach((s) => (text += `▫️ ${s}\n`));
    }
    text += `\n`;
  });
  return text;
}

function joinKeyboard(isAdmin = false) {
  const rows = [
    [
      Markup.button.callback("⚽ ثبت بازیکن", "JOIN_PLAYER"),
      Markup.button.callback("🧤 ثبت دروازه‌بان", "JOIN_GK")
    ]
  ];
  if (isAdmin) {
    rows.push([Markup.button.callback("🔄 قاطی‌کردن دوباره (ادمین)", "RESHUFFLE")]);
  }
  return Markup.inlineKeyboard(rows);
}

// ---------- Commands & Flows ----------

// /start (private & group)
bot.start(async (ctx) => {
  if (ctx.chat.type === "private") {
    const me = await bot.telegram.getMe();
    const link = `https://t.me/${me.username}?startgroup=teamchin`;
    await ctx.reply(
      "🏟 ربات تیم‌چین — تیم‌چینی شانسی و لایو\n\n" +
        "کجا می‌خوای تیم‌چینی انجام بشه؟",
      Markup.inlineKeyboard([
        [Markup.button.callback("👤 داخل ربات", "MODE_PRIVATE")],
        [Markup.button.callback("👥 داخل گروه (ارسال لینک)", "MODE_SEND_LINK")]
      ])
    );
  } else {
    await ctx.reply(
      "برای شروع تیم‌چینی در گروه: ادمین دستور /start_team را اجرا کند"
    );
  }
});

// /start_team (must be run inside group by admin)
bot.command("start_team", async (ctx) => {
  if (ctx.chat.type === "private") return ctx.reply("این دستور را داخل گروه اجرا کنید.");
  // check admin
  const member = await ctx.getChatMember(ctx.chat.id, ctx.from.id);
  if (!["administrator", "creator"].includes(member.status)) {
    return ctx.reply("⛔ فقط ادمین می‌تواند تیم‌چینی را شروع کند.");
  }
  await ctx.reply(
    "🧮 چند تیم؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("🔵 ۲ تیم", "GROUP_TEAMS_2")],
      [Markup.button.callback("🟢 ۳ تیم", "GROUP_TEAMS_3")]
    ])
  );
});

// MODE handlers in private
bot.action("MODE_PRIVATE", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    "🧮 چند تیم می‌خوای؟",
    Markup.inlineKeyboard([
      [
        Markup.button.callback("🔵 ۲ تیم", "P_TEAMS_2"),
        Markup.button.callback("🟢 ۳ تیم", "P_TEAMS_3")
      ]
    ])
  );
});

bot.action("MODE_SEND_LINK", async (ctx) => {
  await ctx.answerCbQuery();
  const me = await bot.telegram.getMe();
  const link = `https://t.me/${me.username}?startgroup=teamchin`;
  await ctx.reply(`👥 روی لینک بزن و ربات را به گروه بفرست، سپس داخل گروه /start_team را اجرا کن:\n\n${link}`);
});

// PRIVATE: user chose team count
bot.action(/P_TEAMS_(\d)/, async (ctx) => {
  await ctx.answerCbQuery();
  const n = Number(ctx.match[1]);
  // set a private-session marker (keyed by chat.id)
  games[ctx.chat.id] = { privateMode: true, teamCount: n };
  await ctx.editMessageText("✍️ لطفاً اسم‌ها را با فاصله بفرست (مثال: Ali Reza Sara)");
});

// Handle text messages for private mode (names list)
bot.on("text", async (ctx) => {
  // private mode names
  const sess = games[ctx.chat.id];
  if (sess && sess.privateMode && sess.teamCount) {
    const tokens = ctx.message.text.split(/\s+/).filter(Boolean);
    if (!tokens.length) return ctx.reply("هیچ اسمی پیدا نشد.");
    shuffleInPlace(tokens);
    const teams = Array.from({ length: sess.teamCount }, () => []);
    tokens.forEach((name, i) => {
      teams[i % sess.teamCount].push(name);
    });
    let out = "🏆 نتیجه تیم‌بندی (پی‌وی):\n\n";
    teams.forEach((t, i) => {
      out += `🔥 تیم ${i + 1}:\n`;
      t.forEach(x => (out += `⚽ ${x}\n`));
      out += "\n";
    });
    delete games[ctx.chat.id];
    return ctx.reply(out);
  }
});

// GROUP: choose team count after /start_team
bot.action(/GROUP_TEAMS_(\d)/, async (ctx) => {
  await ctx.answerCbQuery();
  const teamCount = Number(ctx.match[1]);
  const chatId = ctx.chat.id;

  // init game
  await withLock(chatId, async () => {
    const teams = Array.from({ length: teamCount }, () => ({ gk: null, players: [], subs: [] }));
    games[chatId] = {
      teamCount,
      teams,
      users: {}, // userId -> { name, role }
      messageId: null
    };

    // send join message and save messageId
    const sent = await ctx.reply(
      "🏆 تیم‌چینی شروع شد!\nنقش خودتو انتخاب کن 👇",
      joinKeyboard(true) // show reshuffle button; only admins will be authorized later
    );
    games[chatId].messageId = sent.message_id;
  });
});

// JOIN_GK (group)
bot.action("JOIN_GK", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  if (!games[chatId]) return ctx.answerCbQuery("بازی‌ای فعال نیست", { show_alert: true });

  await withLock(chatId, async () => {
    const game = games[chatId];
    const uid = String(ctx.from.id);
    const name = displayName(ctx.from);

    if (game.users[uid]) return ctx.answerCbQuery("❗ قبلاً ثبت شدی");

    const availableTeams = game.teams.filter(t => t.gk === null);
    if (availableTeams.length === 0) {
      return ctx.answerCbQuery("⛔ همه تیم‌ها دروازه‌بان دارن", { show_alert: true });
    }

    // random team among available
    const team = randomChoice(availableTeams);
    team.gk = name;
    game.users[uid] = { name, role: "gk" };

    await safeUpdateGroupMessage(chatId);
    return ctx.answerCbQuery("🧤 دروازه‌بان ثبت شد");
  });
});

// JOIN_PLAYER (group)
bot.action("JOIN_PLAYER", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  if (!games[chatId]) return ctx.answerCbQuery("بازی‌ای فعال نیست", { show_alert: true });

  await withLock(chatId, async () => {
    const game = games[chatId];
    const uid = String(ctx.from.id);
    const name = displayName(ctx.from);

    if (game.users[uid]) return ctx.answerCbQuery("❗ قبلاً ثبت شدی");

    // teams that have < 4 players
    const available = game.teams.filter(t => t.players.length < 4);
    if (available.length > 0) {
      const team = randomChoice(available);
      team.players.push(name);
    } else {
      // all full -> go to subs (random team)
      const anyTeam = randomChoice(game.teams);
      anyTeam.subs.push(name);
    }
    game.users[uid] = { name, role: "player" };

    await safeUpdateGroupMessage(chatId);
    return ctx.answerCbQuery("✅ ثبت شدی");
  });
});

// RESHUFFLE (admin only)
bot.action("RESHUFFLE", async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const game = games[chatId];
  if (!game) return ctx.answerCbQuery("چیزی برای قاطی کردن نیست", { show_alert: true });

  // check admin or bot owner
  let isAdmin = false;
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    if (["administrator", "creator"].includes(member.status)) isAdmin = true;
  } catch (e) {
    // ignore
  }
  // optionally allow bot owner by environment variable (not set here)

  if (!isAdmin) return ctx.answerCbQuery("⛔ فقط ادمین می‌تواند قاطی کند", { show_alert: true });

  await withLock(chatId, async () => {
    // collect names
    const all_gks = [];
    const all_players = [];
    Object.values(game.teams).forEach(t => {
      if (t.gk) all_gks.push(t.gk);
      all_players.push(...t.players, ...t.subs);
      t.gk = null; t.players = []; t.subs = [];
    });

    shuffleInPlace(all_gks);
    shuffleInPlace(all_players);

    // assign GK randomly to teams (one each until run out)
    all_gks.forEach((gk, i) => {
      const idx = i % game.teamCount;
      game.teams[idx].gk = gk;
    });

    // distribute players: fill up to 4 per team randomly
    all_players.forEach((p, i) => {
      const available = game.teams.filter(t => t.players.length < 4);
      if (available.length > 0) {
        const team = randomChoice(available);
        team.players.push(p);
      } else {
        const team = randomChoice(game.teams);
        team.subs.push(p);
      }
    });

    await safeUpdateGroupMessage(chatId);
    return ctx.answerCbQuery("🎲 دوباره قاطی شد");
  });
});

// safe update: try edit, if fails send new and store messageId
async function safeUpdateGroupMessage(chatId) {
  const game = games[chatId];
  if (!game) return;
  const text = renderTeamsText(game);

  // decide admin button visibility based on last known message sender - simple check:
  // note: we'll show reshuffle button to everyone but actual permission is checked when pressed.
  const keyboard = joinKeyboard(true);
  try {
    if (game.messageId) {
      await bot.telegram.editMessageText(chatId, game.messageId, undefined, text, {
        parse_mode: "HTML",
        reply_markup: keyboard.reply_markup
      });
    } else {
      const sent = await bot.telegram.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard.reply_markup
      });
      game.messageId = sent.message_id;
    }
  } catch (err) {
    // if cannot edit (deleted/old), send new message
    try {
      const sent = await bot.telegram.sendMessage(chatId, text, {
        parse_mode: "HTML",
        reply_markup: keyboard.reply_markup
      });
      game.messageId = sent.message_id;
    } catch (e2) {
      console.error("Failed to update/send group message:", e2 && e2.message);
    }
  }
}

// ---------- Boot ----------
// remove pending updates to avoid stale callback issues on restart
(async () => {
  try {
    await bot.telegram.deleteWebhook().catch(()=>{});
  } catch(e){}
  bot.launch({ dropPendingUpdates: true }).then(() => {
    console.log("Bot launched (polling) — dropPendingUpdates:true");
  });
})();

// graceful stop
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
