const { Telegraf, Markup } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);

// ====== حافظه موقت ======
const groups = {}; 
// groups[groupId] = {
//   teamsCount: 2,
//   teams: [{ gk: null, players: [], subs: [] }, ...],
//   joined: Set(userId)
// }

// ====== ابزار کمکی ======
function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

function renderTeams(group) {
  let text = "🏆 **وضعیت تیم‌ها**\n\n";
  group.teams.forEach((t, i) => {
    text += `🔥 تیم ${i + 1}:\n`;
    if (t.gk) text += `🧤 ${t.gk}\n`;
    t.players.forEach(p => text += `⚽ ${p}\n`);
    if (t.subs.length) {
      text += `🔄 تعویضی‌ها:\n`;
      t.subs.forEach(s => text += `▫️ ${s}\n`);
    }
    text += "\n";
  });
  return text;
}

function randomTeamIndex(count) {
  return Math.floor(Math.random() * count);
}

// ====== /start ======
bot.start(async (ctx) => {
  if (ctx.chat.type === "private") {
    return ctx.reply(
      "🏟 تیم‌چینی کجا انجام بشه؟",
      Markup.inlineKeyboard([
        [Markup.button.callback("👤 داخل ربات", "PLACE_PRIVATE")],
        [Markup.button.callback("👥 داخل گروه", "PLACE_GROUP")]
      ])
    );
  } else {
    return ctx.reply("⚠️ لطفاً استارت رو در پی‌وی بزن.");
  }
});

// ====== انتخاب محل ======
bot.action("PLACE_GROUP", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply(
    "🧮 چند تیم می‌خوای؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("🔵 ۲ تیم", "GROUP_2")],
      [Markup.button.callback("🟢 ۳ تیم", "GROUP_3")]
    ])
  );
});

// ====== انتخاب تعداد تیم ======
bot.action(/GROUP_(2|3)/, async (ctx) => {
  await ctx.answerCbQuery();
  const teamsCount = Number(ctx.match[1]);
  ctx.reply(
    "👥 حالا برو گروه و دستور زیر رو بزن:\n\n/start_team",
    { parse_mode: "Markdown" }
  );
  ctx.session = { teamsCount };
});

// ====== شروع تیم‌چینی در گروه ======
bot.command("start_team", async (ctx) => {
  if (!ctx.chat.type.includes("group")) return;

  const teamsCount = ctx.session?.teamsCount || 2;

  groups[ctx.chat.id] = {
    teamsCount,
    teams: Array.from({ length: teamsCount }, () => ({
      gk: null,
      players: [],
      subs: []
    })),
    joined: new Set()
  };

  ctx.reply(
    "🏆 **تیم‌چینی شروع شد!**\nنقش خودتو انتخاب کن 👇",
    {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [Markup.button.callback("⚽ بازیکن", "JOIN_PLAYER")],
        [Markup.button.callback("🧤 دروازه‌بان", "JOIN_GK")],
        [Markup.button.callback("🔄 قاطی‌کردن دوباره (ادمین)", "RESHUFFLE")]
      ])
    }
  );
});

// ====== ورود بازیکن ======
bot.action("JOIN_PLAYER", async (ctx) => {
  const g = groups[ctx.chat.id];
  if (!g) return ctx.answerCbQuery("❌ تیم‌چینی فعال نیست");

  const id = ctx.from.id;
  if (g.joined.has(id)) return ctx.answerCbQuery("قبلاً ثبت‌نام کردی ❌");

  g.joined.add(id);
  const name = ctx.from.first_name;

  // تیم‌هایی که هنوز کمتر از 4 بازیکن دارن
  let available = g.teams.filter(t => t.players.length < 4);
  if (available.length === 0) {
    // تعویضی
    g.teams[randomTeamIndex(g.teamsCount)].subs.push(name);
  } else {
    shuffle(available)[0].players.push(name);
  }

  await ctx.editMessageText(renderTeams(g), {
    parse_mode: "Markdown",
    ...ctx.update.callback_query.message.reply_markup
  });
  ctx.answerCbQuery("ثبت شد ✅");
});

// ====== ورود دروازه‌بان ======
bot.action("JOIN_GK", async (ctx) => {
  const g = groups[ctx.chat.id];
  if (!g) return ctx.answerCbQuery("❌ تیم‌چینی فعال نیست");

  const id = ctx.from.id;
  if (g.joined.has(id)) return ctx.answerCbQuery("قبلاً ثبت‌نام کردی ❌");

  const freeTeams = g.teams.filter(t => !t.gk);
  if (freeTeams.length === 0) {
    return ctx.answerCbQuery("❌ همه تیم‌ها دروازه‌بان دارن");
  }

  g.joined.add(id);
  const name = ctx.from.first_name;
  shuffle(freeTeams)[0].gk = name;

  await ctx.editMessageText(renderTeams(g), {
    parse_mode: "Markdown",
    ...ctx.update.callback_query.message.reply_markup
  });
  ctx.answerCbQuery("به‌عنوان دروازه‌بان ثبت شد 🧤");
});

// ====== قاطی‌کردن دوباره (ادمین) ======
bot.action("RESHUFFLE", async (ctx) => {
  const g = groups[ctx.chat.id];
  if (!g) return;

  const admins = await ctx.getChatAdministrators();
  if (!admins.find(a => a.user.id === ctx.from.id)) {
    return ctx.answerCbQuery("فقط ادمین ❌");
  }

  let gks = [];
  let players = [];

  g.teams.forEach(t => {
    if (t.gk) gks.push(t.gk);
    players.push(...t.players, ...t.subs);
    t.gk = null;
    t.players = [];
    t.subs = [];
  });

  shuffle(gks);
  shuffle(players);

  gks.forEach((gk, i) => {
    if (g.teams[i]) g.teams[i].gk = gk;
  });

  players.forEach(p => {
    let available = g.teams.filter(t => t.players.length < 4);
    if (available.length === 0) {
      g.teams[randomTeamIndex(g.teamsCount)].subs.push(p);
    } else {
      shuffle(available)[0].players.push(p);
    }
  });

  await ctx.editMessageText(renderTeams(g), {
    parse_mode: "Markdown",
    ...ctx.update.callback_query.message.reply_markup
  });
  ctx.answerCbQuery("تیم‌ها دوباره شانسی شدن 🎲");
});

// ====== اجرا ======
bot.launch();
console.log("🤖 Bot is running...");
