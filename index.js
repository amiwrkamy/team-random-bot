const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is not defined');
}

const bot = new Telegraf(BOT_TOKEN);

// ================== STATE ==================
const groups = {}; // chat_id -> state
const BOT_OWNER_ID = 0; // 👈 بعداً آیدی عددی خودت رو اینجا بذار

function getDisplayName(user) {
  return user.username ? `@${user.username}` : user.first_name;
}

function initGroup(chatId) {
  groups[chatId] = {
    teamCount: null,
    players: [], // {id, name, role}
    teams: []
  };
}

function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

// ================== START ==================
bot.start(async (ctx) => {
  if (ctx.chat.type === 'private') {
    await ctx.reply(
      '🏟 تیم‌چینی کجا انجام بشه؟',
      Markup.inlineKeyboard([
        [Markup.button.callback('👤 داخل ربات', 'MODE_PRIVATE')],
        [Markup.button.callback('👥 داخل گروه', 'MODE_GROUP')]
      ])
    );
  }
});

// ================== MODE SELECT ==================
bot.action('MODE_PRIVATE', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    '🧮 چند تیم می‌خوای؟',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('1️⃣', 'P_TEAM_1'),
        Markup.button.callback('2️⃣', 'P_TEAM_2'),
        Markup.button.callback('3️⃣', 'P_TEAM_3'),
        Markup.button.callback('4️⃣', 'P_TEAM_4')
      ]
    ])
  );
});

bot.action('MODE_GROUP', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    'برای شروع داخل گروه دستور زیر رو بزن:\n\n/start_team'
  );
});

// ================== PRIVATE MODE ==================
bot.action(/P_TEAM_(\d)/, async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = { teamCount: Number(ctx.match[1]) };
  await ctx.reply('✍️ اسم بازیکن‌ها رو با فاصله بفرست');
});

bot.on('text', async (ctx) => {
  if (!ctx.session || !ctx.session.teamCount) return;

  const names = ctx.message.text.split(' ').filter(Boolean);
  const teamCount = ctx.session.teamCount;

  const shuffled = shuffle(names);
  const teams = Array.from({ length: teamCount }, () => []);

  shuffled.forEach((name, i) => {
    teams[i % teamCount].push(name);
  });

  let text = '🏆 نتیجه تیم‌چینی:\n\n';
  teams.forEach((t, i) => {
    text += `تیم ${i + 1}:\n`;
    t.forEach(n => text += `⚽ ${n}\n`);
    text += '\n';
  });

  ctx.session = null;
  await ctx.reply(text);
});

// ================== GROUP MODE ==================
bot.command('start_team', async (ctx) => {
  if (ctx.chat.type === 'private') return;

  const chatId = ctx.chat.id;
  initGroup(chatId);

  await ctx.reply(
    '🧮 چند تیم می‌خوای؟',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('1️⃣', 'G_TEAM_1'),
        Markup.button.callback('2️⃣', 'G_TEAM_2'),
        Markup.button.callback('3️⃣', 'G_TEAM_3'),
        Markup.button.callback('4️⃣', 'G_TEAM_4')
      ]
    ])
  );
});

bot.action(/G_TEAM_(\d)/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const teamCount = Number(ctx.match[1]);

  const group = groups[chatId];
  group.teamCount = teamCount;
  group.teams = Array.from({ length: teamCount }, () => ({
    gk: null,
    players: [],
    subs: []
  }));

  await ctx.editMessageText(
    '🏆 تیم‌چینی شروع شد!\nنقش خودتو انتخاب کن 👇',
    Markup.inlineKeyboard([
      [
        Markup.button.callback('⚽ بازیکن', 'JOIN_PLAYER'),
        Markup.button.callback('🧤 دروازه‌بان', 'JOIN_GK')
      ],
      [Markup.button.callback('🔄 قاطی‌کردن دوباره', 'RESHUFFLE')]
    ])
  );
});

// ================== JOIN PLAYER ==================
bot.action('JOIN_PLAYER', async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const user = ctx.from;
  const group = groups[chatId];

  if (!group) return;

  if (group.players.find(p => p.id === user.id)) return;

  group.players.push({
    id: user.id,
    name: getDisplayName(user),
    role: 'player'
  });

  updateTeams(group);
  await ctx.editMessageText(renderTeams(group), keyboard());
});

// ================== JOIN GK ==================
bot.action('JOIN_GK', async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const user = ctx.from;
  const group = groups[chatId];

  if (!group) return;
  if (group.players.find(p => p.id === user.id)) return;

  const freeTeams = group.teams.filter(t => !t.gk);
  if (freeTeams.length === 0) {
    return ctx.reply('❌ همه تیم‌ها دروازه‌بان دارن');
  }

  group.players.push({
    id: user.id,
    name: getDisplayName(user),
    role: 'gk'
  });

  updateTeams(group);
  await ctx.editMessageText(renderTeams(group), keyboard());
});

// ================== RESHUFFLE ==================
bot.action('RESHUFFLE', async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  const admins = await ctx.getChatAdministrators();
  const isAdmin =
    admins.some(a => a.user.id === userId) || userId === BOT_OWNER_ID;

  if (!isAdmin) {
    return ctx.reply('❌ فقط ادمین می‌تونه این کارو بکنه');
  }

  const group = groups[chatId];
  updateTeams(group, true);
  await ctx.editMessageText(renderTeams(group), keyboard());
});

// ================== HELPERS ==================
function updateTeams(group, reshuffle = false) {
  if (reshuffle) {
    group.teams.forEach(t => {
      t.gk = null;
      t.players = [];
      t.subs = [];
    });
  }

  const gks = shuffle(group.players.filter(p => p.role === 'gk'));
  const players = shuffle(group.players.filter(p => p.role === 'player'));

  gks.forEach((gk, i) => {
    if (group.teams[i]) group.teams[i].gk = gk.name;
  });

  players.forEach(p => {
    const candidates = group.teams.filter(t => t.players.length < 4);
    if (candidates.length > 0) {
      shuffle(candidates)[0].players.push(p.name);
    } else {
      shuffle(group.teams)[0].subs.push(p.name);
    }
  });
}

function renderTeams(group) {
  let text = '🏆 وضعیت تیم‌ها:\n\n';
  group.teams.forEach((t, i) => {
    text += `تیم ${i + 1}:\n`;
    if (t.gk) text += `🧤 ${t.gk}\n`;
    t.players.forEach(p => text += `⚽ ${p}\n`);
    t.subs.forEach(s => text += `🔄 ${s}\n`);
    text += '\n';
  });
  return text;
}

function keyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⚽ بازیکن', 'JOIN_PLAYER'),
      Markup.button.callback('🧤 دروازه‌بان', 'JOIN_GK')
    ],
    [Markup.button.callback('🔄 قاطی‌کردن دوباره', 'RESHUFFLE')]
  ]);
}

// ================== RUN ==================
bot.launch();
console.log('🤖 Bot is running');
