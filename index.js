import { Telegraf, Markup } from "telegraf";

const bot = new Telegraf(process.env.BOT_TOKEN);

// ================== حافظه ==================
const sessions = {}; 
// sessions[chatId] = {
//   mode: "group" | "private",
//   teamsCount: 2 | 3,
//   players: [],
//   goalkeepers: [],
//   teams: []
// }

// ================== ابزار ==================
const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);

function initTeams(count) {
  return Array.from({ length: count }, (_, i) => ({
    name: count === 2
      ? i === 0 ? "🔵 تیم آبی" : "🔥 تیم قرمز"
      : `🏆 تیم ${i + 1}`,
    gk: null,
    players: [],
    subs: []
  }));
}

function rebuildTeams(session) {
  session.teams = initTeams(session.teamsCount);

  // دروازه‌بان‌ها
  shuffle([...session.goalkeepers]).forEach((gk, i) => {
    if (session.teams[i]) session.teams[i].gk = gk;
  });

  // بازیکن‌ها
  shuffle([...session.players]).forEach((p) => {
    const available = session.teams.filter(t => t.players.length < 4);
    if (available.length) {
      shuffle(available)[0].players.push(p);
    } else {
      shuffle(session.teams)[0].subs.push(p);
    }
  });
}

function renderTeams(session) {
  let text = "🏆 **وضعیت تیم‌ها (لایو)**\n\n";
  session.teams.forEach(t => {
    text += `${t.name}\n`;
    text += `🧤 ${t.gk ?? "—"}\n`;
    t.players.forEach(p => text += `⚽ ${p}\n`);
    if (t.subs.length) {
      t.subs.forEach(s => text += `🔄 ${s}\n`);
    }
    text += "\n";
  });
  return text;
}

// ================== استارت ==================
bot.start((ctx) => {
  ctx.reply(
    "🏟 تیم‌چینی کجا انجام بشه؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("👤 داخل ربات", "MODE_PRIVATE")],
      [Markup.button.callback("👥 داخل گروه", "MODE_GROUP")]
    ])
  );
});

// ================== انتخاب حالت ==================
bot.action("MODE_GROUP", async (ctx) => {
  await ctx.answerCbQuery();
  ctx.reply(
    "🧮 چند تیم می‌خوای؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("🔵 ۲ تیم", "TEAMS_2")],
      [Markup.button.callback("🟢 ۳ تیم", "TEAMS_3")]
    ])
  );
});

// ================== تعداد تیم ==================
bot.action(/TEAMS_(2|3)/, async (ctx) => {
  await ctx.answerCbQuery();
  const count = Number(ctx.match[1]);

  sessions[ctx.chat.id] = {
    mode: "group",
    teamsCount: count,
    players: [],
    goalkeepers: [],
    teams: initTeams(count)
  };

  ctx.reply(
    "🏆 تیم‌چینی شروع شد!\nنقش خودتو انتخاب کن 👇",
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

// ================== ثبت بازیکن ==================
bot.action("JOIN_PLAYER", async (ctx) => {
  const s = sessions[ctx.chat.id];
  if (!s) return ctx.answerCbQuery("❌ تیم‌چینی فعال نیست");

  const name = ctx.from.first_name;
  if (s.players.includes(name) || s.goalkeepers.includes(name)) {
    return ctx.answerCbQuery("قبلاً ثبت شدی ❌");
  }

  s.players.push(name);
  rebuildTeams(s);

  await ctx.editMessageText(renderTeams(s), {
    parse_mode: "Markdown",
    ...ctx.update.callback_query.message.reply_markup
  });

  ctx.answerCbQuery("ثبت شد ⚽");
});

// ================== ثبت دروازه‌بان ==================
bot.action("JOIN_GK", async (ctx) => {
  const s = sessions[ctx.chat.id];
  if (!s) return ctx.answerCbQuery("❌ تیم‌چینی فعال نیست");

  const name = ctx.from.first_name;
  if (s.players.includes(name) || s.goalkeepers.includes(name)) {
    return ctx.answerCbQuery("قبلاً ثبت شدی ❌");
  }

  if (s.goalkeepers.length >= s.teamsCount) {
    return ctx.answerCbQuery("❗ همه تیم‌ها دروازه‌بان دارن");
  }

  s.goalkeepers.push(name);
  rebuildTeams(s);

  await ctx.editMessageText(renderTeams(s), {
    parse_mode: "Markdown",
    ...ctx.update.callback_query.message.reply_markup
  });

  ctx.answerCbQuery("ثبت شد 🧤");
});

// ================== ریشافل (ادمین) ==================
bot.action("RESHUFFLE", async (ctx) => {
  const s = sessions[ctx.chat.id];
  if (!s) return;

  const admins = await ctx.getChatAdministrators();
  const isAdmin = admins.some(a => a.user.id === ctx.from.id);
  if (!isAdmin) return ctx.answerCbQuery("⛔ فقط ادمین");

  rebuildTeams(s);

  await ctx.editMessageText(renderTeams(s), {
    parse_mode: "Markdown",
    ...ctx.update.callback_query.message.reply_markup
  });

  ctx.answerCbQuery("تیم‌ها دوباره شانسی شدن 🎲");
});

// ================== اجرا ==================
bot.launch();
console.log("🤖 Team-Chin Bot is running...");
