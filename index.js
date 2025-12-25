const { Telegraf, Markup } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);

// ===== START =====
bot.start(async (ctx) => {
  try {
    await ctx.reply(
      "⚽ خوش اومدی!\nکجا می‌خوای تیم‌کشی انجام بدی؟",
      Markup.inlineKeyboard([
        [Markup.button.callback("🤖 داخل ربات", "IN_BOT")],
        [Markup.button.callback("👥 داخل گروه", "IN_GROUP")]
      ])
    );
  } catch (e) {
    console.error("START ERROR:", e);
  }
});

// ===== INSIDE BOT =====
bot.action("IN_BOT", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.reply(
      "🔢 چند تیم می‌خوای؟",
      Markup.inlineKeyboard([
        [
          Markup.button.callback("2️⃣ تیم", "BOT_TEAM_2"),
          Markup.button.callback("3️⃣ تیم", "BOT_TEAM_3"),
          Markup.button.callback("4️⃣ تیم", "BOT_TEAM_4")
        ]
      ])
    );
  } catch (e) {
    console.error("IN_BOT ERROR:", e);
  }
});

// ===== INSIDE GROUP =====
bot.action("IN_GROUP", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const link = `https://t.me/${ctx.botInfo.username}?startgroup=true`;

    await ctx.reply(
      "👥 ربات رو به گروه اضافه کن:",
      Markup.inlineKeyboard([
        [Markup.button.url("➕ افزودن به گروه", link)]
      ])
    );
  } catch (e) {
    console.error("IN_GROUP ERROR:", e);
  }
});

// ===== BOT TEAM COUNT (TEST) =====
bot.action(/BOT_TEAM_\d/, async (ctx) => {
  try {
    await ctx.answerCbQuery();
    const count = ctx.callbackQuery.data.split("_").pop();
    await ctx.reply(`✅ انتخاب شد: ${count} تیم`);
  } catch (e) {
    console.error("TEAM COUNT ERROR:", e);
  }
});

// ===== GLOBAL ERROR HANDLER =====
bot.catch((err) => {
  console.error("BOT CRASH:", err);
});

// ===== LAUNCH =====
bot.launch().then(() => {
  console.log("🤖 Bot is running");
});

// برای Render
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
