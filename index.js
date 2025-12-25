const { Telegraf, Markup } = require('telegraf');

const TOKEN = process.env.BOT_TOKEN || 'YOUR_TOKEN_HERE';
if (!TOKEN || TOKEN === 'YOUR_TOKEN_HERE') {
  console.error('Please set BOT token in BOT_TOKEN env or replace YOUR_TOKEN_HERE');
  process.exit(1);
}

const bot = new Telegraf(TOKEN);

// ذخیرهٔ جلسات بازی‌ها بر اساس chat id
// هر بازی ساختار:
// {
//   players: [{id, name}], 
//   registration_message_id,
//   registration_chat_id,
//   is_shots_started: false,
//   shots: {}
// }
const games = {};

// کمک: می‌سازیم یک کیبوردِ ثبت نام با دکمه‌ها (JOIN, START_SHOTS, RESHUFFLE)
function registrationKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('➕ ورود به بازی', 'JOIN_GAME')],
    [Markup.button.callback('⚽ شروع شوت‌زنی', 'START_SHOTS')],
    [Markup.button.callback('🔀 قاطی‌کردن دوباره (فقط ادمین)', 'RESHUFFLE')],
  ]);
}

function playersListText(players) {
  if (!players || players.length === 0) return '— هیچ بازیکنی ثبت نشده.';
  return players.map((p, idx) => `${idx + 1}. ${p.name}`).join('\n');
}

// استارت
bot.start(async (ctx) => {
  try {
    await ctx.reply(
      "⚽ به بازی فوتبال خوش اومدی!\n\nچی کار می‌خوای بکنی؟",
      Markup.inlineKeyboard([[Markup.button.callback('🏟 شروع بازی فوتبال', 'START_GAME')]])
    );
  } catch (e) {
    console.error('start error', e);
  }
});

// START_GAME: پیام ثبت نام در گروه یا پیوی
bot.action('START_GAME', async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    // initialize game object
    games[chatId] = {
      players: [],
      registration_message_id: null,
      registration_chat_id: chatId,
      is_shots_started: false,
      shots: {}
    };

    // edit original message (if possible) or reply
    const text = `👥 ثبت‌نام برای بازی شروع شد!\n\nهر کسی می‌خواهد شرکت کند روی «➕ ورود به بازی» بزند.\n\n📋 لیست فعلی:\n${playersListText(games[chatId].players)}\n\n📌 نکته: فقط یک‌بار می‌توانید ثبت‌نام کنید.`;
    // Try to edit the callback message (so it shows inline keyboard under same message)
    const msg = ctx.update.callback_query && ctx.update.callback_query.message;
    if (msg && msg.message_id) {
      const sent = await ctx.editMessageText(text, {
        reply_markup: registrationKeyboard().reply_markup
      });
      // save registration message id
      games[chatId].registration_message_id = msg.message_id;
    } else {
      const sent = await ctx.reply(text, registrationKeyboard());
      games[chatId].registration_message_id = sent.message_id;
    }

    await ctx.answerCbQuery();
  } catch (err) {
    console.error('START_GAME error', err);
    try { await ctx.answerCbQuery('خطا رخ داد.'); } catch(e){}
  }
});

// JOIN_GAME: ثبت نام بازیکن
bot.action('JOIN_GAME', async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const user = ctx.from;
    const game = games[chatId];
    if (!game) {
      await ctx.answerCbQuery('جلسه‌ای باز نیست. ابتدا "شروع بازی" را بزنید.', { show_alert: true });
      return;
    }
    if (game.is_shots_started) {
      await ctx.answerCbQuery('ثبت‌نام بسته شده؛ بازی شروع شده.', { show_alert: true });
      return;
    }
    if (game.players.some(p => p.id === user.id)) {
      await ctx.answerCbQuery('❌ شما قبلاً ثبت‌نام کرده‌اید.', { show_alert: true });
      return;
    }

    // ثبت بازیکن
    const name = user.username ? `@${user.username}` : (user.first_name || 'ناشناس');
    game.players.push({ id: user.id, name });

    // آپدیت پیام ثبت‌نام (ویرایش پیام قبلی) — اینجا مهمه: پیام قبلی باید ذخیره شده باشه
    const regMsgId = game.registration_message_id;
    const regChatId = game.registration_chat_id || chatId;
    const newText = `👥 ثبت‌نام برای بازی ادامه دارد!\n\nهر کسی می‌خواهد شرکت کند روی «➕ ورود به بازی» بزند.\n\n📋 لیست فعلی:\n${playersListText(game.players)}\n\n📌 نکته: فقط یک‌بار می‌توانید ثبت‌نام کنید.`;
    try {
      if (regMsgId) {
        await ctx.telegram.editMessageText(regChatId, regMsgId, null, newText, {
          reply_markup: registrationKeyboard().reply_markup
        });
      } else {
        // fallback – send new message and save id
        const sent = await ctx.reply(newText, registrationKeyboard());
        game.registration_message_id = sent.message_id;
        game.registration_chat_id = sent.chat.id;
      }
    } catch (editErr) {
      // اگر edit نشد، فِیل‌بک: ارسال پیام جدید ولی اعلام می‌کنیم
      console.warn('edit failed in JOIN_GAME:', editErr);
      const sent = await ctx.reply(newText, registrationKeyboard());
      game.registration_message_id = sent.message_id;
      game.registration_chat_id = sent.chat.id;
    }

    await ctx.answerCbQuery('✅ شما به بازی اضافه شدید.');
  } catch (err) {
    console.error('JOIN_GAME error', err);
    try { await ctx.answerCbQuery('خطا در ثبت‌نام.'); } catch(e){}
  }
});

// START_SHOTS: اجرای بازی (اینجا شبیه نمونهٔ تو — هر بازیکن یک dice می‌زند)
bot.action('START_SHOTS', async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const game = games[chatId];
    if (!game) {
      await ctx.answerCbQuery('جلسه‌ای باز نیست. ابتدا "شروع بازی" را بزنید.', { show_alert: true });
      return;
    }
    if (game.players.length < 2) {
      await ctx.answerCbQuery('❌ حداقل ۲ نفر نیاز است.', { show_alert: true });
      return;
    }
    // علامت گذاری که ثبت نام بسته شد
    game.is_shots_started = true;

    // ویرایش پیام ثبت نام تا اعلام شروع شود
    const regMsgId = game.registration_message_id;
    const regChatId = game.registration_chat_id || chatId;
    try {
      if (regMsgId) {
        await ctx.telegram.editMessageText(regChatId, regMsgId, null, '⚽ شوت‌زنی شروع شد!\nهر بازیکن یک شوت می‌زنه...', {
          reply_markup: registrationKeyboard().reply_markup
        });
      } else {
        await ctx.reply('⚽ شوت‌زنی شروع شد!\nهر بازیکن یک شوت می‌زنه...');
      }
    } catch (e) {
      console.warn('edit failed in START_SHOTS:', e);
      await ctx.reply('⚽ شوت‌زنی شروع شد!\nهر بازیکن یک شوت می‌زنه...');
    }

    // هر بازیکن یک dice می‌فرستیم و نتیجه را ذخیره می‌کنیم
    game.shots = {};
    for (const player of game.players) {
      // sendDice returns a message with dice
      const diceMsg = await ctx.telegram.sendDice(chatId, { emoji: '⚽' });
      // بعضی مواقع dice.dice may be available as diceMsg.dice
      const val = diceMsg?.dice?.value ?? Math.floor(Math.random() * 6) + 1;
      game.shots[player.name] = val;
      // هر بار کوتاه یه تیکه پیام بفرست (اختیاری) — اینجا نمی‌فرستیم اضافی تا flood نشه
    }

    // نتیجه نهایی
    let result = '🏆 نتیجه بازی:\n\n';
    for (const [name, value] of Object.entries(game.shots)) {
      result += `⚽ ${name} → ${value}\n`;
    }
    await ctx.reply(result);
    await ctx.answerCbQuery();
  } catch (err) {
    console.error('START_SHOTS error', err);
    try { await ctx.answerCbQuery('خطا در شروع بازی.'); } catch(e){}
  }
});

// RESHUFFLE: فقط ادمین می‌تواند — باید لیست بازیکنان را شانسی دوباره مرتب کند و پیام ثبت‌نام را ویرایش کند (edit)
bot.action('RESHUFFLE', async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const user = ctx.from;
    const game = games[chatId];
    if (!game) {
      await ctx.answerCbQuery('جلسه‌ای باز نیست.', { show_alert: true });
      return;
    }

    // بررسی ادمین بودن کاربر در گروه — اگر در چت خصوصی است، خود کاربر را ادمین فرض نمی‌کنیم
    let isAdmin = false;
    try {
      const admins = await ctx.getChatAdministrators();
      isAdmin = admins.some(a => a.user && a.user.id === user.id);
    } catch (err) {
      // اگر خطا شد (مثلاً در چت خصوصی) — همچنان اجازه نمی‌دهیم مگر اینکه در گپ نباشد.
      console.warn('getChatAdministrators failed:', err);
    }

    if (!isAdmin) {
      await ctx.answerCbQuery('⚠️ فقط ادمین گروه می‌تواند قاطی کند.', { show_alert: true });
      return;
    }

    if (!game.players || game.players.length === 0) {
      await ctx.answerCbQuery('هیچ بازیکنی وجود ندارد که قاطی شود.', { show_alert: true });
      return;
    }

    // shuffle players array (Fisher-Yates)
    for (let i = game.players.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [game.players[i], game.players[j]] = [game.players[j], game.players[i]];
    }

    // سپس پیام ثبت‌نام را ویرایش کن (editMessageText) — همین‌جا باید پیام id ذخیره شده باشد
    const regMsgId = game.registration_message_id;
    const regChatId = game.registration_chat_id || chatId;

    const newText = `🔀 قاطی شد! (فقط ادمین اجرا کرد)\n\n📋 لیست جدید بازیکنان:\n${playersListText(game.players)}\n\n📌 نکته: فقط یک‌بار می‌توانید ثبت‌نام کنید.`;

    try {
      if (regMsgId) {
        await ctx.telegram.editMessageText(regChatId, regMsgId, null, newText, {
          reply_markup: registrationKeyboard().reply_markup
        });
        // پاسخ به کلید فشرده شده (بدون alert)
        await ctx.answerCbQuery('🔀 بازیکنان قاطی شدند و پیام ویرایش شد.');
      } else {
        // fallback — اگر بدون msgId باشه، ارسال پیام جدید ولی ذخیره id
        const sent = await ctx.reply(newText, registrationKeyboard());
        game.registration_message_id = sent.message_id;
        game.registration_chat_id = sent.chat.id;
        await ctx.answerCbQuery('🔀 بازیکنان قاطی شدند (پیام جدید ارسال شد).');
      }
    } catch (editErr) {
      console.error('RESHUFFLE edit failed:', editErr);
      // اگر ویرایش نتونست انجام شه، سعی می‌کنیم حداقل پیام رو به‌روزرسانی کنیم با reply و اطلاع
      try {
        const sent = await ctx.reply(newText, registrationKeyboard());
        game.registration_message_id = sent.message_id;
        game.registration_chat_id = sent.chat.id;
        await ctx.answerCbQuery('🔀 بازیکنان قاطی شدند (fallback پیام جدید ارسال شد).');
      } catch (sendErr) {
        console.error('RESHUFFLE fallback send failed:', sendErr);
        await ctx.answerCbQuery('خطا در قاطی کردن — لطفاً بعداً تلاش کنید.', { show_alert: true });
      }
    }

  } catch (err) {
    console.error('RESHUFFLE error:', err);
    try { await ctx.answerCbQuery('خطا در عملیات قاطی کردن.'); } catch(e){}
  }
});

// خطاها را لاگ کن
bot.catch((err) => {
  console.error('Bot error', err);
});

// اجرای بات (polling)
(async () => {
  try {
    await bot.launch();
    console.log('Bot launched');
  } catch (err) {
    console.error('Failed to launch bot', err);
  }
})();

// graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
