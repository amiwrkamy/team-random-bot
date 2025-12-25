const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN || "TOKEN_BOT");

const games = {};

// استارت
bot.start((ctx) => {
  ctx.reply(
    "⚽ به بازی فوتبال خوش اومدی!\n\nچی کار می‌خوای بکنی؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("🏟 شروع بازی فوتبال", "START_GAME")]
    ])
  );
});

// شروع بازی
bot.action("START_GAME", (ctx) => {
  const chatId = ctx.chat.id;

  games[chatId] = {
    players: [],
    started: false
  };

  ctx.editMessageText(
    "👥 بازیکن‌ها ثبت‌نام کنن:\nهر نفر فقط یک بار ⬇️",
    Markup.inlineKeyboard([
      [Markup.button.callback("➕ ورود به بازی", "JOIN_GAME")],
      [Markup.button.callback("⚽ شروع شوت‌زنی", "START_SHOTS")]
    ])
  );
});

// ورود بازیکن
bot.action("JOIN_GAME", (ctx) => {
  const chatId = ctx.chat.id;
  const user = ctx.from;

  const game = games[chatId];
  if (!game || game.started) {
    return ctx.answerCbQuery("❌ بازی شروع شده");
  }

  if (game.players.find(p => p.id === user.id)) {
    return ctx.answerCbQuery("❌ قبلاً وارد شدی");
  }

  game.players.push({
    id: user.id,
    name: user.first_name
  });

  ctx.answerCbQuery("✅ وارد بازی شدی");
});

// شروع شوت‌زنی
bot.action("START_SHOTS", async (ctx) => {
  const chatId = ctx.chat.id;
  const game = games[chatId];

  if (!game || game.players.length < 2) {
    return ctx.answerCbQuery("❌ حداقل ۲ نفر لازمه");
  }

  game.started = true;

  // جلوگیری از خطای message is not modified
  try {
    await ctx.editMessageText("⚽ شوت‌زنی شروع شد!\nهر بازیکن یک شوت می‌زنه...");
  } catch (e) {}

  const results = [];

  for (const player of game.players) {
    const dice = await ctx.telegram.sendDice(chatId, { emoji: "⚽" });
    results.push({
      name: player.name,
      value: dice.dice.value
    });
  }

  let resultText = "🏆 نتیجه بازی:\n\n";
  results.forEach(r => {
    resultText += `⚽ ${r.name} → ${r.value}\n`;
  });

  ctx.reply(resultText);

  // پاک‌سازی بازی
  delete games[chatId];
});

// هندل خطا (برای نخوابیدن ربات)
bot.catch(() => {});

// لانچ
bot.launch().then(() => {
  console.log("🤖 Bot is running safely");
});

// خاموش شدن تمیز
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
