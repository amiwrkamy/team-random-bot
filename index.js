require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const crypto = require("crypto");

const bot = new Telegraf(process.env.BOT_TOKEN);

// حافظه سشن‌ها
const sessions = {};

// ابزار رندوم واقعی
function randomPick(arr) {
  return arr[crypto.randomInt(arr.length)];
}

// گرفتن اسم درست کاربر
function getName(user) {
  return user.username ? `@${user.username}` : user.first_name;
}

// شروع
bot.start((ctx) => {
  ctx.reply(
    "🏟 تیم‌چینی کجا انجام بشه؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("👤 داخل ربات", "MODE_PRIVATE")],
      [Markup.button.callback("👥 داخل گروه", "MODE_GROUP")]
    ])
  );
});

// انتخاب حالت
bot.action("MODE_GROUP", (ctx) => {
  ctx.reply(
    "🧮 چند تیم می‌خوای؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("1️⃣", "TEAM_1"), Markup.button.callback("2️⃣", "TEAM_2")],
      [Markup.button.callback("3️⃣", "TEAM_3"), Markup.button.callback("4️⃣", "TEAM_4")]
    ])
  );
});

bot.action(/TEAM_(\d+)/, (ctx) => {
  const teamCount = Number(ctx.match[1]);
  const chatId = ctx.chat.id;

  sessions[chatId] = {
    teamCount,
    teams: Array.from({ length: teamCount }, () => ({
      gk: null,
      players: [],
      subs: []
    })),
    messageId: null
  };

  ctx.reply(
    "🏆 تیم‌چینی شروع شد!\nنقش خودتو انتخاب کن 👇",
    Markup.inlineKeyboard([
      [Markup.button.callback("⚽ بازیکن", "JOIN_PLAYER")],
      [Markup.button.callback("🧤 دروازه‌بان", "JOIN_GK")],
      [Markup.button.callback("🔄 قاطی‌کردن دوباره (ادمین)", "RESHUFFLE")]
    ])
  ).then((msg) => {
    sessions[chatId].messageId = msg.message_id;
  });
});

// ثبت دروازه‌بان
bot.action("JOIN_GK", (ctx) => {
  const chatId = ctx.chat.id;
  const session = sessions[chatId];
  if (!session) return;

  const name = getName(ctx.from);

  // تیم‌هایی که GK ندارن
  const available = session.teams.filter(t => !t.gk);
  if (available.length === 0) {
    return ctx.answerCbQuery("❌ همه تیم‌ها دروازه‌بان دارن", { show_alert: true });
  }

  const team = randomPick(available);
  team.gk = name;

  updateMessage(ctx, session);
});

// ثبت بازیکن
bot.action("JOIN_PLAYER", (ctx) => {
  const chatId = ctx.chat.id;
  const session = sessions[chatId];
  if (!session) return;

  const name = getName(ctx.from);

  const available = session.teams.filter(t => t.players.length < 4);
  if (available.length === 0) {
    // تعویضی
    randomPick(session.teams).subs.push(name);
    updateMessage(ctx, session);
    return;
  }

  randomPick(available).players.push(name);
  updateMessage(ctx, session);
});

// قاطی‌کردن دوباره (ادمین)
bot.action("RESHUFFLE", async (ctx) => {
  const chatId = ctx.chat.id;
  const member = await ctx.getChatMember(ctx.from.id);
  if (!["administrator", "creator"].includes(member.status)) {
    return ctx.answerCbQuery("❌ فقط ادمین", { show_alert: true });
  }

  const session = sessions[chatId];
  if (!session) return;

  const all = [];
  session.teams.forEach(t => {
    if (t.gk) all.push({ name: t.gk, role: "gk" });
    t.players.forEach(p => all.push({ name: p, role: "player" }));
    t.subs.forEach(s => all.push({ name: s, role: "sub" }));
    t.gk = null; t.players = []; t.subs = [];
  });

  all.forEach(p => {
    if (p.role === "gk") {
      const t = randomPick(session.teams.filter(x => !x.gk));
      t.gk = p.name;
    } else if (p.role === "player") {
      const t = randomPick(session.teams.filter(x => x.players.length < 4));
      t.players.push(p.name);
    } else {
      randomPick(session.teams).subs.push(p.name);
    }
  });

  updateMessage(ctx, session);
});

// آپدیت پیام
function updateMessage(ctx, session) {
  let text = "🏆 وضعیت تیم‌ها:\n\n";
  session.teams.forEach((t, i) => {
    text += `🔹 تیم ${i + 1}:\n`;
    if (t.gk) text += `🧤 ${t.gk}\n`;
    t.players.forEach(p => text += `⚽ ${p}\n`);
    t.subs.forEach(s => text += `🔄 ${s}\n`);
    text += "\n";
  });

  ctx.telegram.editMessageText(
    ctx.chat.id,
    session.messageId,
    null,
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback("⚽ بازیکن", "JOIN_PLAYER")],
      [Markup.button.callback("🧤 دروازه‌بان", "JOIN_GK")],
      [Markup.button.callback("🔄 قاطی‌کردن دوباره (ادمین)", "RESHUFFLE")]
    ])
  );
}

bot.launch();
