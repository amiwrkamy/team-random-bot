import express from "express";
import { Telegraf, Markup } from "telegraf";
import dotenv from "dotenv";

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 10000;
const DOMAIN = process.env.DOMAIN; // آدرس Render

if (!BOT_TOKEN || !DOMAIN) {
  console.error("❌ BOT_TOKEN یا DOMAIN ست نشده");
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

app.use(express.json());

/* =====================
   BOT COMMANDS
===================== */

bot.start((ctx) => {
  ctx.reply(
    "🤖 ربات تیم‌کشی آماده است",
    Markup.keyboard([
      ["🎲 تیم‌کشی"],
      ["ℹ️ راهنما"]
    ]).resize()
  );
});

bot.hears("ℹ️ راهنما", (ctx) => {
  ctx.reply("روی 🎲 تیم‌کشی بزن تا شروع کنیم");
});

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
  ctx.reply(`✅ ${ctx.match[1]} تیم انتخاب شد`);
});

/* =====================
   WEBHOOK
===================== */

app.post("/telegram", (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

app.get("/", (req, res) => {
  res.send("🤖 Bot is alive");
});

(async () => {
  try {
    await bot.telegram.deleteWebhook();
    await bot.telegram.setWebhook(`${DOMAIN}/telegram`);
    console.log("✅ Webhook set");
  } catch (err) {
    console.error("❌ Webhook error:", err);
  }
})();

app.listen(PORT, () => {
  console.log(`🌐 Server running on ${PORT}`);
});
