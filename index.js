require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const crypto = require('crypto');
const express = require('express');

const bot = new Telegraf(process.env.BOT_TOKEN);

// keep alive
const app = express();
app.get('/', (_, res) => res.send('OK'));
app.listen(process.env.PORT || 3000);

// ----------------- utils -----------------
const rnd = arr => arr[crypto.randomInt(arr.length)];
const shuffle = arr => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
};
const uname = u => u.username ? `@${u.username}` : u.first_name;

// ----------------- state -----------------
const pvSession = {}; // userId -> teamCount
const games = {};     // chatId -> game

// ----------------- START -----------------
bot.start(async ctx => {
  if (ctx.chat.type !== 'private') return;

  const me = await bot.telegram.getMe();
  const link = `https://t.me/${me.username}?startgroup=teamchin`;

  ctx.reply(
    '🏟 تیم‌چینی کجا انجام بشه؟',
    Markup.inlineKeyboard([
      [Markup.button.callback('👤 داخل بات', 'PV')],
      [Markup.button.callback('👥 داخل گروه', 'GROUP')]
    ])
  );

  bot.action('GROUP', async c => {
    await c.answerCbQuery();
    c.reply(`👥 ربات رو به گروه اضافه کن:\n${link}`);
  });

  bot.action('PV', async c => {
    await c.answerCbQuery();
    c.reply(
      '🧮 چند تیم؟',
      Markup.inlineKeyboard([
        [Markup.button.callback('2️⃣', 'PV_2'), Markup.button.callback('3️⃣', 'PV_3'), Markup.button.callback('4️⃣', 'PV_4')]
      ])
    );
  });
});

// ----------------- PV FLOW -----------------
bot.action(/PV_(\d)/, async ctx => {
  pvSession[ctx.from.id] = Number(ctx.match[1]);
  ctx.reply('✍️ اسم بازیکن‌ها رو با فاصله بفرست');
});

bot.on('text', ctx => {
  if (ctx.chat.type !== 'private') return;
  const n = pvSession[ctx.from.id];
  if (!n) return;

  const names = ctx.message.text.split(/\s+/);
  shuffle(names);

  const teams = Array.from({ length: n }, () => []);
  names.forEach((p, i) => teams[i % n].push(p));

  let out = '🏆 نتیجه:\n\n';
  teams.forEach((t, i) => {
    out += `🔥 تیم ${i + 1}\n`;
    t.forEach(p => out += `⚽ ${p}\n`);
    out += '\n';
  });

  delete pvSession[ctx.from.id];
  ctx.reply(out);
});

// ----------------- GROUP FLOW -----------------
bot.on('my_chat_member', async ctx => {
  const chat = ctx.chat;
  if (chat.type === 'group' || chat.type === 'supergroup') {
    bot.telegram.sendMessage(chat.id,
      '🧮 چند تیم؟',
      Markup.inlineKeyboard([
        [Markup.button.callback('2️⃣', 'G_2'), Markup.button.callback('3️⃣', 'G_3'), Markup.button.callback('4️⃣', 'G_4')]
      ])
    );
  }
});

bot.action(/G_(\d)/, async ctx => {
  const n = Number(ctx.match[1]);
  const chatId = ctx.chat.id;

  games[chatId] = {
    teams: Array.from({ length: n }, () => ({ gk: null, players: [], subs: [] })),
    users: {},
    msgId: null
  };

  const msg = await ctx.reply(render(chatId), keyboard(true));
  games[chatId].msgId = msg.message_id;
});

bot.action('PLAYER', ctx => join(ctx, 'player'));
bot.action('GK', ctx => join(ctx, 'gk'));

async function join(ctx, role) {
  const g = games[ctx.chat.id];
  if (!g) return;

  const id = ctx.from.id;
  if (g.users[id]) return ctx.answerCbQuery('⛔ فقط یک بار');

  const name = uname(ctx.from);

  if (role === 'gk') {
    const free = g.teams.filter(t => !t.gk);
    if (!free.length) return ctx.answerCbQuery('❌ GK تکمیل');
    rnd(free).gk = name;
  } else {
    const free = g.teams.filter(t => t.players.length < 4);
    free.length ? rnd(free).players.push(name) : rnd(g.teams).subs.push(name);
  }

  g.users[id] = true;
  await bot.telegram.editMessageText(ctx.chat.id, g.msgId, null, render(ctx.chat.id), keyboard(true));
  ctx.answerCbQuery('✅ ثبت شد');
}

// ----------------- UI -----------------
const keyboard = admin =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('⚽ بازیکن', 'PLAYER'),
      Markup.button.callback('🧤 دروازه‌بان', 'GK')
    ],
    ...(admin ? [[Markup.button.callback('🔄 قاطی دوباره', 'RESHUFFLE')]] : [])
  ]);

function render(chatId) {
  const g = games[chatId];
  let t = '🏆 تیم‌ها:\n\n';
  g.teams.forEach((x, i) => {
    t += `🔥 تیم ${i + 1}\n`;
    t += `🧤 ${x.gk || '—'}\n`;
    x.players.forEach(p => t += `⚽ ${p}\n`);
    if (x.subs.length) {
      t += '🔄 تعویضی:\n';
      x.subs.forEach(s => t += `▫️ ${s}\n`);
    }
    t += '\n';
  });
  return t;
}

bot.launch();
