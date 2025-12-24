const { Telegraf, Markup } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);

// حافظه ساده برای هر چت
const sessions = {};

// تابع شانسی واقعی
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

// /start
bot.start(async (ctx) => {
  sessions[ctx.chat.id] = {};
  await ctx.reply(
    "🏟 تیم‌چینی کجا انجام بشه؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("👤 داخل ربات", "IN_BOT")],
      [Markup.button.callback("👥 داخل گروه", "IN_GROUP")]
    ])
  );
});

// داخل ربات
bot.action("IN_BOT", async (ctx) => {
  sessions[ctx.chat.id] = { mode: "bot" };
  await ctx.editMessageText(
    "🧮 چند تیم می‌خوای؟",
    Markup.inlineKeyboard([
      [
        Markup.button.callback("1️⃣", "TEAM_1"),
        Markup.button.callback("2️⃣", "TEAM_2"),
        Markup.button.callback("3️⃣", "TEAM_3"),
        Markup.button.callback("4️⃣", "TEAM_4")
      ]
    ])
  );
});

// انتخاب تعداد تیم
bot.action(/TEAM_(\d)/, async (ctx) => {
  const count = Number(ctx.match[1]);
  sessions[ctx.chat.id].teams = count;
  await ctx.editMessageText(
    "✍️ اسم بازیکن‌ها رو با فاصله بفرست\n(آیدی اگر داشت، وگرنه اسم)"
  );
});

// دریافت اسم‌ها
bot.on("text", async (ctx) => {
  const session = sessions[ctx.chat.id];
  if (!session || !session.teams) return;

  let players = ctx.message.text
    .split(" ")
    .map((p) => p.trim())
    .filter(Boolean);

  players = shuffle(players);

  const teams = Array.from({ length: session.teams }, () => []);

  players.forEach((p, i) => {
    teams[i % session.teams].push(p);
  });

  let result = "🏆 نتیجه تیم‌چینی:\n\n";
  teams.forEach((t, i) => {
    result += `🔥 تیم ${i + 1}:\n`;
    t.forEach((p) => (result += `⚽ ${p}\n`));
    result += "\n";
  });

  await ctx.reply(result);
  delete sessions[ctx.chat.id];
});

// داخل گروه (فعلاً پیام راهنما)
bot.action("IN_GROUP", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    "👥 برای گروه:\nربات رو به گروه اضافه کن و دستور /team رو بزن"
  );
});

// اجرای امن
bot.launch({
  polling: {
    timeout: 30
  }
});

console.log("🤖 Bot is running");

// خاموش شدن امن
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
