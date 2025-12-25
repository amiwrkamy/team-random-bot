// index.js — FINAL STABLE VERSION (Render + Polling only)

const { Telegraf, Markup } = require('telegraf');
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is missing');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

/* ---------------- SERVER ---------------- */
app.get('/', (req, res) => res.send('Bot is running'));
app.listen(PORT, () => {
  console.log(`HTTP server running on port ${PORT}`);
});

/* ---------------- BOT ---------------- */
(async () => {
  try {
    // ❗ خیلی مهم
    await bot.telegram.deleteWebhook();
    console.log('Webhook deleted');

    await bot.launch({
      polling: {
        interval: 300,
        timeout: 30,
      },
    });

    console.log('Bot started with polling');
  } catch (err) {
    console.error('Bot failed to start:', err);
    process.exit(1);
  }
})();

/* ---------------- BASIC TEST ---------------- */
bot.start((ctx) => {
  ctx.reply(
    '🤖 ربات تیم‌کشی فعال شد\n\nانتخاب کن:',
    Markup.inlineKeyboard([
      [Markup.button.callback('⚽ داخل ربات', 'inside_bot')],
      [Markup.button.callback('👥 داخل گروه', 'inside_group')],
    ])
  );
});

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;

  if (data === 'inside_bot') {
    await ctx.answerCbQuery();
    return ctx.reply('🔢 چند تیم؟', Markup.inlineKeyboard([
      [Markup.button.callback('2️⃣', 't2')],
      [Markup.button.callback('3️⃣', 't3')],
      [Markup.button.callback('4️⃣', 't4')],
    ]));
  }

  if (data === 'inside_group') {
    await ctx.answerCbQuery();
    const me = await bot.telegram.getMe();
    return ctx.reply(
      `➕ ربات رو به گروه اضافه کن:\nhttps://t.me/${me.username}?startgroup=true`
    );
  }

  await ctx.answerCbQuery();
});

/* ---------------- SAFE EXIT ---------------- */
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
