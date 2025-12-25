const { Telegraf, Markup } = require('telegraf');
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error("BOT_TOKEN is not defined");
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

const games = {}; // وضعیت هر چت

// =====================
// START
// =====================
bot.start(async (ctx) => {
  await ctx.reply(
    "⚽️ به ربات تیم‌کشی خوش اومدی\n\nیکی رو انتخاب کن:",
    Markup.inlineKeyboard([
      [Markup.button.callback("🤖 داخل ربات", "IN_BOT")],
      [Markup.button.callback("👥 داخل گروه", "IN_GROUP")]
    ])
  );
});

// =====================
// داخل ربات
// =====================
bot.action("IN_BOT", async (ctx) => {
  await ctx.editMessageText(
    "🔢 چند تیم می‌خوای؟",
    Markup.inlineKeyboard([
      [
        Markup.button.callback("2️⃣ تیم", "BOT_TEAMS_2"),
        Markup.button.callback("3️⃣ تیم", "BOT_TEAMS_3"),
        Markup.button.callback("4️⃣ تیم", "BOT_TEAMS_4")
      ]
    ])
  );
});

// =====================
// داخل گروه (لینک)
–=====================
bot.action("IN_GROUP", async (ctx) => {
  const botUsername = ctx.botInfo.username;
  const link = `https://t.me/${botUsername}?startgroup=true`;

  await ctx.editMessageText(
    "👥 ربات رو به گروه اضافه کن:",
    Markup.inlineKeyboard([
      [Markup.button.url("➕ افزودن به گروه", link)]
    ])
  );
});

// =====================
// انتخاب تعداد تیم (ربات)
// =====================
["2", "3", "4"].forEach((n) => {
  bot.action(`BOT_TEAMS_${n}`, async (ctx) => {
    const chatId = ctx.chat.id;

    games[chatId] = {
      mode: "bot",
      teamsCount: Number(n),
      players: []
    };

    await ctx.editMessageText(
      `✍️ اسم‌ها رو بفرست (هر خط یک نفر)\n\nمثال:\nAli\nReza\nHassan`
    );
  });
});

// =====================
// دریافت اسم‌ها (ربات)
// =====================
bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  const game = games[chatId];

  if (!game || game.mode !== "bot") return;

  const names = ctx.message.text
    .split("\n")
    .map(t => t.trim())
    .filter(Boolean);

  if (names.length < game.teamsCount) {
    return ctx.reply("❌ تعداد اسم‌ها کمه");
  }

  // شافل
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }

  const teams = Array.from({ length: game.teamsCount }, () => []);

  names.forEach((name, i) => {
    teams[i % game.teamsCount].push(name);
  });

  let result = "🏆 نتیجه تیم‌کشی:\n\n";
  teams.forEach((team, i) => {
    result += `🔹 تیم ${i + 1}:\n`;
    team.forEach(p => result += `• ${p}\n`);
    result += "\n";
  });

  delete games[chatId];
  await ctx.reply(result);
});

// =====================
// خطاگیر (خیلی مهم)
// =====================
bot.catch((err) => {
  console.error("BOT ERROR:", err);
});

// =====================
// WEBHOOK (Render-safe)
// =====================
const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL; 
// مثال: https://your-app.onrender.com

app.use(express.json());
app.post(`/telegraf/${BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body, res);
});

app.get("/", (req, res) => {
  res.send("Bot is alive");
});

app.listen(PORT, async () => {
  if (!WEBHOOK_URL) {
    console.log("⚠️ WEBHOOK_URL not set");
    return;
  }

  await bot.telegram.setWebhook(`${WEBHOOK_URL}/telegraf/${BOT_TOKEN}`);
  console.log("✅ Webhook set");
});
