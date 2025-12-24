require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

/* ===================== STATE ===================== */

const privateSessions = {};
const groupSessions = {};

/* ===================== UTILS ===================== */

const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);

const buildGroupText = (g) => {
  let text = '🏆 وضعیت تیم‌ها (لایو)\n\n';

  g.teams.forEach((t, i) => {
    text += `🔵 تیم ${i + 1}\n`;
    if (t.gk) text += `🧤 ${t.gk}\n`;
    t.players.forEach(p => text += `⚽ ${p}\n`);
    text += '\n';
  });

  if (g.subs.length)
    text += `🔄 تعویضی‌ها:\n${g.subs.join('\n')}\n\n`;

  text += '📌 هر نفر فقط یک‌بار می‌تواند ثبت‌نام کند\n';
  text += '👑 فقط ادمین می‌تواند 🔀 قاطی‌کردن را بزند';

  return text;
};

const groupKeyboard = Markup.inlineKeyboard([
  [
    Markup.button.callback('⚽ بازیکن', 'join_player'),
    Markup.button.callback('🧤 دروازه‌بان', 'join_gk')
  ],
  [
    Markup.button.callback('🔀 قاطی‌کردن (ادمین)', 'reshuffle')
  ]
]);

/* ===================== START ===================== */

bot.start(async (ctx) => {
  if (ctx.chat.type !== 'private') return;

  await ctx.reply(
    '🎯 تیم‌چینی کجا انجام شود؟',
    Markup.inlineKeyboard([
      [Markup.button.callback('🤖 داخل ربات', 'mode_private')],
      [Markup.button.callback('👥 داخل گروه', 'mode_group')]
    ])
  );
});

/* ===================== MODE SELECT ===================== */

bot.action('mode_private', async (ctx) => {
  privateSessions[ctx.chat.id] = {};
  await ctx.editMessageText(
    '🔢 چند تیم می‌خواهی؟',
    Markup.inlineKeyboard([
      [Markup.button.callback('۲ تیم', 'p_2')],
      [Markup.button.callback('۳ تیم', 'p_3')],
      [Markup.button.callback('۴ تیم', 'p_4')]
    ])
  );
});

bot.action('mode_group', async (ctx) => {
  const link = `https://t.me/${ctx.botInfo.username}?startgroup=true`;
  await ctx.editMessageText(
    '👥 ربات را به گروه اضافه کن و داخل گروه دستور /start_team را بزن',
    Markup.inlineKeyboard([
      [Markup.button.url('➕ افزودن ربات به گروه', link)]
    ])
  );
});

/* ===================== PRIVATE MODE ===================== */

bot.action(/^p_(\d)$/, async (ctx) => {
  const teams = Number(ctx.match[1]);
  privateSessions[ctx.chat.id] = { teams };

  await ctx.editMessageText(
    `✍️ اسامی را بفرست (هر خط یک نفر)\n\n🧤 ابتدا گلرها (${teams} نفر)\n⚽ بعد بازیکن‌ها`
  );
});

bot.on('text', async (ctx) => {
  const sess = privateSessions[ctx.chat.id];
  if (!sess) return;

  const names = ctx.message.text.split('\n').map(x => x.trim()).filter(Boolean);
  if (names.length < sess.teams)
    return ctx.reply('❌ تعداد گلرها کافی نیست');

  const gks = shuffle(names.slice(0, sess.teams));
  const players = shuffle(names.slice(sess.teams));

  const teams = Array.from({ length: sess.teams }, (_, i) => ({
    gk: gks[i],
    players: []
  }));

  players.forEach(p => {
    const t = teams.reduce((a, b) =>
      a.players.length < b.players.length ? a : b
    );
    if (t.players.length < 4) t.players.push(p);
  });

  let text = '🏆 نتیجه تیم‌چینی\n\n';
  teams.forEach((t, i) => {
    text += `🔵 تیم ${i + 1}\n🧤 ${t.gk}\n`;
    t.players.forEach(p => text += `⚽ ${p}\n`);
    text += '\n';
  });

  await ctx.reply(text);
  delete privateSessions[ctx.chat.id];
});

/* ===================== GROUP MODE ===================== */

bot.command('start_team', async (ctx) => {
  if (ctx.chat.type === 'private') return;

  const member = await ctx.getChatMember(ctx.from.id);
  if (!['administrator', 'creator'].includes(member.status))
    return ctx.reply('⛔ فقط ادمین');

  await ctx.reply(
    '🔢 تعداد تیم‌ها؟',
    Markup.inlineKeyboard([
      [Markup.button.callback('۲ تیم', 'g_2')],
      [Markup.button.callback('۳ تیم', 'g_3')],
      [Markup.button.callback('۴ تیم', 'g_4')]
    ])
  );
});

bot.action(/^g_(\d)$/, async (ctx) => {
  const teamsCount = Number(ctx.match[1]);

  groupSessions[ctx.chat.id] = {
    teamsCount,
    teams: Array.from({ length: teamsCount }, () => ({ gk: null, players: [] })),
    subs: [],
    users: {},
    messageId: null
  };

  const msg = await ctx.reply(buildGroupText(groupSessions[ctx.chat.id]), groupKeyboard);
  groupSessions[ctx.chat.id].messageId = msg.message_id;
});

/* ===================== JOIN PLAYER ===================== */

bot.action('join_player', async (ctx) => {
  const g = groupSessions[ctx.chat.id];
  if (!g) return;

  if (g.users[ctx.from.id])
    return ctx.answerCbQuery('قبلاً ثبت شدی');

  g.users[ctx.from.id] = true;
  const name = ctx.from.first_name;

  const team = g.teams.reduce((a, b) =>
    (a.players.length + (a.gk ? 1 : 0)) <
    (b.players.length + (b.gk ? 1 : 0)) ? a : b
  );

  if (team.players.length + (team.gk ? 1 : 0) < 5)
    team.players.push(name);
  else
    g.subs.push(name);

  await bot.telegram.editMessageText(
    ctx.chat.id,
    g.messageId,
    null,
    buildGroupText(g),
    groupKeyboard
  );

  ctx.answerCbQuery('✅ ثبت شد');
});

/* ===================== JOIN GK ===================== */

bot.action('join_gk', async (ctx) => {
  const g = groupSessions[ctx.chat.id];
  if (!g) return;

  if (g.users[ctx.from.id])
    return ctx.answerCbQuery('قبلاً ثبت شدی');

  const team = g.teams.find(t => !t.gk);
  if (!team)
    return ctx.answerCbQuery('همه تیم‌ها گلر دارند');

  g.users[ctx.from.id] = true;
  team.gk = ctx.from.first_name;

  await bot.telegram.editMessageText(
    ctx.chat.id,
    g.messageId,
    null,
    buildGroupText(g),
    groupKeyboard
  );

  ctx.answerCbQuery('🧤 گلر ثبت شد');
});

/* ===================== RESHUFFLE ===================== */

bot.action('reshuffle', async (ctx) => {
  const member = await ctx.getChatMember(ctx.from.id);
  if (!['administrator', 'creator'].includes(member.status))
    return ctx.answerCbQuery('⛔ فقط ادمین');

  const g = groupSessions[ctx.chat.id];
  if (!g) return;

  let all = [];
  g.teams.forEach(t => {
    if (t.gk) all.push({ n: t.gk, r: 'gk' });
    t.players.forEach(p => all.push({ n: p, r: 'p' }));
  });
  g.subs.forEach(s => all.push({ n: s, r: 'p' }));

  shuffle(all);
  g.teams = Array.from({ length: g.teamsCount }, () => ({ gk: null, players: [] }));
  g.subs = [];

  all.forEach(x => {
    if (x.r === 'gk') {
      const t = g.teams.find(t => !t.gk);
      if (t) t.gk = x.n;
    } else {
      const t = g.teams.find(t => t.players.length + (t.gk ? 1 : 0) < 5);
      if (t) t.players.push(x.n);
      else g.subs.push(x.n);
    }
  });

  await bot.telegram.editMessageText(
    ctx.chat.id,
    g.messageId,
    null,
    buildGroupText(g),
    groupKeyboard
  );

  ctx.answerCbQuery('🔀 دوباره شانسی شد');
});

/* ===================== RUN ===================== */

bot.launch();
console.log('✅ Bot is running');
