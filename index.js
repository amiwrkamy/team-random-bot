import { Telegraf } from "telegraf";
import dotenv from "dotenv";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error("❌ BOT_TOKEN is missing");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// =====================
// COMMANDS
// =====================
bot.start((ctx) => {
  ctx.reply("🤖 ربات با موفقیت اجرا شد");
});

bot.command("ping", (ctx) => {
  ctx.reply("🏓 pong");
});

// =====================
// SAFE LAUNCH (POLLING)
// =====================
(async () => {
  try {
    // خیلی مهم: حذف کامل webhook
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });

    await bot.launch({
      polling: {
        timeout: 50
      }
    });

    console.log("✅ Bot started (polling only)");
  } catch (err) {
    console.error("❌ Bot launch error:", err);
    process.exit(1);
  }
})();

// =====================
// GRACEFUL SHUTDOWN
// =====================
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
