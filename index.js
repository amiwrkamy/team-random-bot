const { Telegraf, Markup } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);

// حافظه موقت
const sessions = {};
const groupGames = {};

// ابزار
function getName(user) {
  return user.username ? `@${user.username}` : user.first_name;
}

function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

// ───────────────── START ─────────────────
bot.start((ctx) => {
  sessions[ctx.chat.id] = {};

  ctx.reply(
    "🏟 تیم‌چینی کجا انجام بشه؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("👤 داخل ربات", "MODE_PRIVATE")],
      [Markup.button.callback("👥 داخل گروه", "MODE_GROUP")],
    ])
  );
});

// ───────────────── MODE SELECT ─────────────────
bot.action("MODE_PRIVATE", (ctx) => {
  sessions[ctx.chat.id] = { mode: "private" };

  ctx.editMessageText(
    "🧮 چند تیم می‌خوای؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("🔵 ۲ تیم", "P_TEAMS_2")],
      [Markup.button.callback("🟢 ۳ تیم", "P_TEAMS_3")],
    ])
  );
});

bot.action("MODE_GROUP", async (ctx) => {
  sessions[ctx.chat.id] = { mode: "group" };

  await ctx.answerCbQuery();

  await ctx.reply(
    "🧮 چند تیم می‌خوای؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("🔵 ۲ تیم", "G_TEAMS_2")],
      [Markup.button.callback("🟢 ۳ تیم", "G_TEAMS_3")],
    ])
  );
});

// ───────────────── PRIVATE MODE ─────────────────
bot.action(["P_TEAMS_2", "P_TEAMS_3"], async (ctx) => {
  const teams = ctx.match[0].endsWith("2") ? 2 : 3;

  sessions[ctx.chat.id] = {
    mode: "private",
    step: "WAIT_NAMES",
    teams,
  };

  await ctx.editMessageText(
    "✍️ اسم بازیکن‌ها رو با فاصله بفرست\nمثال:\nAli Reza Amir"
  );
});

bot.on("text", (ctx) => {
  const session = sessions[ctx.chat.id];
  if (!session || session.mode !== "private") return;
  if (session.step !== "WAIT_NAMES") return;

  const names = ctx.message.text.split(" ").filter(Boolean);
  const shuffled = shuffle(names);

  const teams = Array.from({ length: session.teams }, () => []);

  shuffled.forEach((name, i) => {
    teams[i % session.teams].push(name);
  });

  let msg = "🏆 نتیجه تیم‌چینی:\n\n";
  teams.forEach((t, i) => {
    msg += `🔥 تیم ${i + 1}:\n`;
    t.forEach((n) => (msg += `⚽ ${n}\n`));
    msg += "\n";
  });

  session.step = null;
  ctx.reply(msg);
});

// ───────────────── GROUP MODE ─────────────────
bot.action(["G_TEAMS_2", "G_TEAMS_3"], async (ctx) => {
  const teamCount = ctx.match[0].endsWith("2") ? 2 : 3;
  const chatId = ctx.chat.id;

  const teams = {};
  for (let i = 1; i <= teamCount; i++) {
    teams[i] = {
      gk: null,
      players: [],
      subs: [],
    };
  }

  groupGames[chatId] = {
    teams,
    teamCount,
    messageId: null,
  };

  await ctx.answerCbQuery();

  const sent = await ctx.telegram.sendMessage(
    chatId,
    "🏆 تیم‌چینی شروع شد!\nنقش خودتو انتخاب کن 👇",
    Markup.inlineKeyboard([
      [
        Markup.button.callback("⚽ بازیکن", "JOIN_PLAYER"),
        Markup.button.callback("🧤 دروازه‌بان", "JOIN_GK"),
      ],
      [Markup.button.callback("🔄 قاطی‌کردن دوباره (ادمین)", "RESHUFFLE")],
    ])
  );

  groupGames[chatId].messageId = sent.message_id;
});

// ───────────────── JOIN PLAYER ─────────────────
bot.action("JOIN_PLAYER", async (ctx) => {
  const game = groupGames[ctx.chat.id];
  if (!game) return;

  const name = getName(ctx.from);

  // جلوگیری از ثبت دوباره
  for (const t of Object.values(game.teams)) {
    if (
      t.players.includes(name) ||
      t.subs.includes(name) ||
      t.gk === name
    ) {
      return ctx.answerCbQuery("قبلاً ثبت شدی ⚠️", { show_alert: true });
    }
  }

  const available = Object.values(game.teams).filter(
    (t) => t.players.length < 4
  );

  if (available.length > 0) {
    shuffle(available)[0].players.push(name);
  } else {
    shuffle(Object.values(game.teams))[0].subs.push(name);
  }

  await ctx.answerCbQuery("ثبت شد ✅");
  updateGroupMessage(ctx.chat.id);
});

// ───────────────── JOIN GK ─────────────────
bot.action("JOIN_GK", async (ctx) => {
  const game = groupGames[ctx.chat.id];
  if (!game) return;

  const name = getName(ctx.from);

  const available = Object.values(game.teams).filter((t) => !t.gk);
  if (available.length === 0) {
    return ctx.answerCbQuery("همه تیم‌ها دروازه‌بان دارن ❌", {
      show_alert: true,
    });
  }

  shuffle(available)[0].gk = name;

  await ctx.answerCbQuery("دروازه‌بان ثبت شد 🧤");
  updateGroupMessage(ctx.chat.id);
});

// ───────────────── RESHUFFLE (ADMIN) ─────────────────
bot.action("RESHUFFLE", async (ctx) => {
  const member = await ctx.getChatMember(ctx.from.id);
  if (!["administrator", "creator"].includes(member.status)) {
    return ctx.answerCbQuery("فقط ادمین ❌", { show_alert: true });
  }

  const game = groupGames[ctx.chat.id];
  if (!game) return;

  let gks = [];
  let players = [];

  Object.values(game.teams).forEach((t) => {
    if (t.gk) gks.push(t.gk);
    players.push(...t.players, ...t.subs);
    t.gk = null;
    t.players = [];
    t.subs = [];
  });

  shuffle(gks).forEach((gk, i) => {
    game.teams[(i % game.teamCount) + 1].gk = gk;
  });

  shuffle(players).forEach((p) => {
    const available = Object.values(game.teams).filter(
      (t) => t.players.length < 4
    );
    if (available.length > 0) {
      shuffle(available)[0].players.push(p);
    } else {
      shuffle(Object.values(game.teams))[0].subs.push(p);
    }
  });

  await ctx.answerCbQuery("دوباره قاطی شد 🎲");
  updateGroupMessage(ctx.chat.id);
});

// ───────────────── UPDATE MESSAGE ─────────────────
function updateGroupMessage(chatId) {
  const game = groupGames[chatId];
  if (!game) return;

  let text = "🏆 وضعیت تیم‌ها (لایو)\n\n";

  Object.entries(game.teams).forEach(([i, t]) => {
    text += `🔥 تیم ${i}:\n`;
    if (t.gk) text += `🧤 ${t.gk}\n`;
    t.players.forEach((p) => (text += `⚽ ${p}\n`));
    t.subs.forEach((s) => (text += `🔄 ${s}\n`));
    text += "\n";
  });

  bot.telegram.editMessageText(
    chatId,
    game.messageId,
    null,
    text,
    Markup.inlineKeyboard([
      [
        Markup.button.callback("⚽ بازیکن", "JOIN_PLAYER"),
        Markup.button.callback("🧤 دروازه‌بان", "JOIN_GK"),
      ],
      [Markup.button.callback("🔄 قاطی‌کردن دوباره (ادمین)", "RESHUFFLE")],
    ])
  );
}

// ───────────────── LAUNCH ─────────────────
bot.launch();
