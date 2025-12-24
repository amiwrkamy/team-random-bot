const { Telegraf, Markup } = require('telegraf');
const bot = new Telegraf(process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN');

/* ================== STATE ================== */
const chats = {}; // state per group
const locks = new Map();

/* ================== UTILS ================== */
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withLock(chatId, fn) {
  while (locks.get(chatId)) await sleep(40);
  locks.set(chatId, true);
  try { await fn(); }
  finally { locks.delete(chatId); }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function displayName(user) {
  return user.username ? `@${user.username}` : user.first_name;
}

/* ================== UI ================== */
function teamKeyboard(isAdmin = false) {
  const rows = [
    [
      Markup.button.callback('⚽ بازیکن', 'role_player'),
      Markup.button.callback('🧤 دروازه‌بان', 'role_keeper')
    ]
  ];
  if (isAdmin) {
    rows.push([Markup.button.callback('🔄 شانس دوباره', 'reshuffle')]);
  }
  return Markup.inlineKeyboard(rows);
}

function formatTeams(state) {
  let out = `🏆 تیم‌چینی شانسی شروع شد 🎲\n\n`;
  state.teams.forEach((t, i) => {
    out += `🔹 تیم ${i + 1}\n`;
    if (t.keeper) out += `🧤 ${t.keeper}\n`;
    t.players.forEach(p => out += `⚽ ${p}\n`);
    if (t.subs.length) {
      out += `🔄 تعویضی‌ها:\n`;
      t.subs.forEach(s => out += `▫️ ${s}\n`);
    }
    out += '\n';
  });
  return out;
}

/* ================== LOGIC ================== */
function initTeams(count) {
  return Array.from({ length: count }, () => ({
    keeper: null,
    players: [],
    subs: []
  }));
}

function assignRandom(state, name, role) {
  let candidates = [];

  if (role === 'keeper') {
    candidates = state.teams.filter(t => !t.keeper);
    if (!candidates.length) return false;
    shuffle(candidates);
    candidates[0].keeper = name;
    return true;
  }

  // player
  candidates = state.teams.filter(
    t => (t.players.length + (t.keeper ? 1 : 0)) < 5
  );

  if (candidates.length) {
    candidates.sort((a, b) =>
      (a.players.length + (a.keeper ? 1 : 0)) -
      (b.players.length + (b.keeper ? 1 : 0))
    );
    candidates[0].players.push(name);
  } else {
    shuffle(state.teams);
    state.teams[0].subs.push(name);
  }
  return true;
}

/* ================== START ================== */
bot.start(ctx => {
  ctx.reply(
    '🏟 تیم‌چینی کجا انجام بشه؟',
    Markup.inlineKeyboard([
      [Markup.button.callback('👤 داخل ربات', 'mode_private')],
      [Markup.button.callback('👥 داخل گروه', 'mode_group')]
    ])
  );
});

/* ================== PRIVATE MODE ================== */
bot.action('mode_private', ctx => {
  ctx.editMessageText(
    '🔢 چند تیم می‌خوای؟',
    Markup.inlineKeyboard([
      [Markup.button.callback('2️⃣', 'p_2'), Markup.button.callback('3️⃣', 'p_3'), Markup.button.callback('4️⃣', 'p_4')]
    ])
  );
});

bot.action(/p_(\d)/, ctx => {
  ctx.session = { teams: Number(ctx.match[1]) };
  ctx.editMessageText('✍️ اسم‌ها رو با فاصله بفرست');
});

bot.on('text', ctx => {
  if (!ctx.session?.teams) return;
  const names = ctx.message.text.split(/\s+/);
  shuffle(names);

  const state = { teams: initTeams(ctx.session.teams) };
  names.forEach(n => assignRandom(state, n, 'player'));

  ctx.reply(formatTeams(state));
  ctx.session = null;
});

/* ================== GROUP MODE ================== */
bot.action('mode_group', ctx => {
  ctx.reply(
    '👇 ربات رو به گروه بفرست',
    Markup.inlineKeyboard([
      [Markup.button.url('➕ افزودن به گروه', `https://t.me/${ctx.botInfo.username}?startgroup=true`)]
    ])
  );
});

bot.on('new_chat_members', ctx => {
  if (!ctx.message.new_chat_members.some(m => m.id === ctx.botInfo.id)) return;

  ctx.reply(
    '🔢 تعداد تیم‌ها؟',
    Markup.inlineKeyboard([
      [Markup.button.callback('2️⃣', 'g_2'), Markup.button.callback('3️⃣', 'g_3'), Markup.button.callback('4️⃣', 'g_4')]
    ])
  );
});

bot.action(/g_(\d)/, async ctx => {
  const chatId = ctx.chat.id;

  chats[chatId] = {
    teams: initTeams(Number(ctx.match[1])),
    registered: {},
    message_id: null
  };

  const msg = await ctx.reply(
    formatTeams(chats[chatId]),
    teamKeyboard(true)
  );

  chats[chatId].message_id = msg.message_id;
});

/* ================== ROLE HANDLERS ================== */
bot.action('role_player', ctx => handleJoin(ctx, 'player'));
bot.action('role_keeper', ctx => handleJoin(ctx, 'keeper'));

async function handleJoin(ctx, role) {
  const chatId = ctx.chat.id;
  const uid = ctx.from.id;

  await withLock(chatId, async () => {
    const state = chats[chatId];
    if (!state) return ctx.answerCbQuery('❌ فعال نیست');

    if (state.registered[uid])
      return ctx.answerCbQuery('⛔ فقط یک‌بار');

    const ok = assignRandom(state, displayName(ctx.from), role);
    if (!ok) return ctx.answerCbQuery('❌ امکان ثبت نیست');

    state.registered[uid] = true;

    await ctx.telegram.editMessageText(
      chatId,
      state.message_id,
      null,
      formatTeams(state),
      { reply_markup: teamKeyboard(ctx.chat.type === 'supergroup') }
    );

    ctx.answerCbQuery('✅ ثبت شد');
  });
}

/* ================== ADMIN RESHUFFLE ================== */
bot.action('reshuffle', async ctx => {
  const chatId = ctx.chat.id;
  const member = await ctx.getChatMember(ctx.from.id);
  if (!['administrator', 'creator'].includes(member.status))
    return ctx.answerCbQuery('👑 فقط ادمین');

  await withLock(chatId, async () => {
    const state = chats[chatId];
    const all = [];

    state.teams.forEach(t => {
      if (t.keeper) all.push({ n: t.keeper, r: 'keeper' });
      t.players.forEach(p => all.push({ n: p, r: 'player' }));
      t.subs.forEach(s => all.push({ n: s, r: 'player' }));
    });

    state.teams = initTeams(state.teams.length);
    shuffle(all);
    all.forEach(x => assignRandom(state, x.n, x.r));

    await ctx.telegram.editMessageText(
      chatId,
      state.message_id,
      null,
      formatTeams(state),
      { reply_markup: teamKeyboard(true) }
    );
    ctx.answerCbQuery('🎲 دوباره شانسی شد');
  });
});

/* ================== RUN ================== */
bot.launch();
console.log('🤖 Bot is running...');
