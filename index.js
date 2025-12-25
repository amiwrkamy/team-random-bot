import { Telegraf, Markup } from "telegraf";
import dotenv from "dotenv";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN not found");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// =======================
// START
// =======================
bot.start((ctx) => {
  ctx.reply(
    "🤖 ربات تیم‌کشی آماده است",
    Markup.keyboard([
      ["🎲 تیم‌کشی"],
      ["ℹ️ راهنما"]
    ]).resize()
  );
});

// =======================
// HELP
// =======================
bot.hears("ℹ️ راهنما", (ctx) => {
  ctx.reply("📌 برای شروع تیم‌کشی روی 🎲 تیم‌کشی بزن");
});

// =======================
// TEAM RANDOM
// =======================
bot.hears("🎲 تیم‌کشی", (ctx) => {
  ctx.reply(
    "تعداد تیم‌ها رو انتخاب کن 👇",
    Markup.inlineKeyboard([
      [Markup.button.callback("2️⃣ تیم", "team_2")],
      [Markup.button.callback("3️⃣ تیم", "team_3")],
      [Markup.button.callback("4️⃣ تیم", "team_4")]
    ])
  );
});

bot.action(/team_(\d)/, (ctx) => {
  const count = ctx.match[1];
  ctx.answerCbQuery();
  ctx.reply(`✅ ${count} تیم انتخاب شد\n(منطق تیم‌کشی بعداً اضافه میشه)`);
});

// =======================
// SAFE LAUNCH (NO 409)
// =======================
(async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });

    await bot.launch({
      polling: {
        timeout: 50
      }
    });

    console.log("✅ Bot is running");
  } catch (err) {
    console.error("❌ Launch error:", err);
    process.exit(1);
  }
})();

// =======================
// SHUTDOWN
// =======================
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
