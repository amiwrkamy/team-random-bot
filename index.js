const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN || "TOKEN_BOT");

const games = {}; // ذخیره بازی‌ها

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
    shots: {}
  };

  ctx.editMessageText(
    "👥 بازیکن‌ها ثبت‌نام کنن:\n\nهر نفر روی دکمه زیر بزنه ⬇️",
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

  if (!games[chatId]) return;

  if (games[chatId].players.find(p => p.id === user.id)) {
    return ctx.answerCbQuery("❌ قبلاً وارد شدی");
  }

  games[chatId].players.push({
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

  ctx.editMessageText("⚽ شوت‌زنی شروع شد!\nهر بازیکن یک شوت می‌زنه...");

  for (const player of game.players) {
    const dice = await ctx.telegram.sendDice(chatId, { emoji: "⚽" });
    game.shots[player.name] = dice.dice.value;
  }

  let result = "🏆 نتیجه بازی:\n\n";
  for (const [name, value] of Object.entries(game.shots)) {
    result += `⚽ ${name} → ${value}\n`;
  }

  ctx.reply(result);
});

// جلوگیری از کرش
bot.catch(() => {});

bot.launch();
