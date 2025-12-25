const { Telegraf, Markup } = require("telegraf");

const BOT_TOKEN = process.env.BOT_TOKEN || "TOKEN_BOT";
const bot = new Telegraf(BOT_TOKEN);

const games = {}; // ذخیره بازی‌ها بر اساس chatId

// ================= START =================
bot.start((ctx) => {
  ctx.reply(
    "⚽ به بازی فوتبال خوش اومدی!\n\nچی کار می‌خوای بکنی؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("🏟 شروع بازی فوتبال", "START_GAME")]
    ])
  );
});

// ================= START GAME =================
bot.action("START_GAME", (ctx) => {
  const chatId = ctx.chat.id;

  games[chatId] = {
    players: [],
    shots: {},
    started: false
  };

  ctx.editMessageText(
    "👥 بازیکن‌ها ثبت‌نام کنن:\n\nهر نفر فقط یک بار می‌تونه وارد بشه ⬇️",
    Markup.inlineKeyboard([
      [Markup.button.callback("➕ ورود به بازی", "JOIN_GAME")],
      [Markup.button.callback("⚽ شروع شوت‌زنی", "START_SHOTS")]
    ])
  );
});

// ================= JOIN GAME =================
bot.action("JOIN_GAME", (ctx) => {
  const chatId = ctx.chat.id;
  const user = ctx.from;
  const game = games[chatId];

  if (!game) {
    return ctx.answerCbQuery("❌ بازی‌ای وجود نداره");
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

// ================= START SHOTS =================
bot.action("START_SHOTS", async (ctx) => {
  const chatId = ctx.chat.id;
  const game = games[chatId];

  if (!game || game.players.length < 2) {
    return ctx.answerCbQuery("❌ حداقل ۲ نفر لازمه");
  }

  if (game.started) {
    return ctx.answerCbQuery("⏳ بازی قبلاً شروع شده");
  }

  game.started = true;
  game.shots = {};

  await ctx.editMessageText(
    "⚽ شوت‌زنی شروع شد!\n\nهر بازیکن یک شوت می‌زنه..."
  );

  for (const player of game.players) {
    const dice = await ctx.telegram.sendDice(chatId, { emoji: "⚽" });
    game.shots[player.name] = dice.dice.value;
  }

  let result = "🏆 نتیجه بازی:\n\n";
  for (const [name, value] of Object.entries(game.shots)) {
    result += `⚽ ${name} → ${value}\n`;
  }

  await ctx.reply(result);
});

// ================= ERROR HANDLER =================
bot.catch((err) => {
  console.error("Bot Error:", err);
});

// ================= LAUNCH =================
bot.launch();
console.log("🤖 Bot is running with polling");

// برای خاموش شدن امن
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
