import { Telegraf, Markup } from "telegraf";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN not found");
  process.exit(1);
}

/* =========================
   HTTP SERVER (FOR RENDER)
========================= */
const app = express();

app.get("/", (req, res) => {
  res.send("🤖 Telegram bot is running");
});

app.listen(PORT, () => {
  console.log(`🌐 HTTP server running on port ${PORT}`);
});

/* =========================
   TELEGRAM BOT
========================= */
const bot = new Telegraf(BOT_TOKEN);

/* START */
bot.start((ctx) => {
  ctx.reply(
    "🤖 ربات تیم‌کشی آماده است",
    Markup.keyboard([
      ["🎲 تیم‌کشی"],
      ["ℹ️ راهنما"]
    ]).resize()
  );
});

/* HELP */
bot.hears("ℹ️ راهنما", (ctx) => {
  ctx.reply("📌 روی 🎲 تیم‌کشی بزن تا شروع کنیم");
});

/* TEAM RANDOM */
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

bot.action(/team_(\d)/, async (ctx) => {
  await ctx.answerCbQuery();
  const count = ctx.match[1];
  ctx.reply(`✅ ${count} تیم انتخاب شد`);
});

/* =========================
   SAFE LAUNCH
========================= */
(async () => {
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });

    await bot.launch({
      polling: {
        timeout: 50
      }
    });

    console.log("✅ Bot polling started");
  } catch (err) {
    console.error("❌ Bot launch failed:", err);
    process.exit(1);
  }
})();

/* SHUTDOWN */
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
