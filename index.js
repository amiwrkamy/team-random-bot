// index.js
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const crypto = require('crypto');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('ERROR: BOT_TOKEN env var not set');
  process.exit(1);
}
const bot = new Telegraf(TOKEN);

// tiny server so Render keeps service alive
const app = express();
app.get('/', (req, res) => res.send('teamchin bot alive'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('web server listening on', PORT));

// ---------- in-memory games store ----------
const games = Object.create(null); // chatId -> game
const privateSessions = Object.create(null); // userId -> { teamCount }

// per-chat lock
const locks = new Map();
const wait = ms => new Promise(r => setTimeout(r, ms));
async function withLock(id, fn) {
  while (locks.get(id)) await wait(10);
  locks.set(id, true);
  try { return await fn(); } finally { locks.delete(id); }
}

// ---------- helpers ----------
function displayName(user) {
  if (!user) return 'کاربر';
  return user.username ? `@${user.username}` : (user.first_name || 'کاربر');
}
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function randomChoice(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[crypto.randomInt(arr.length)];
}
function buildJoinKeyboard(showAdmin=false) {
  const rows = [
    [
      Markup.button.callback('⚽ ثبت بازیکن', 'JOIN_PLAYER'),
      Markup.button.callback('🧤 ثبت دروازه‌بان', 'JOIN_GK')
    ]
  ];
  if (showAdmin) rows.push([Markup.button.callback('🔄 قاطی‌کردن دوباره (ادمین)', 'RESHUFFLE')]);
  return Markup.inlineKeyboard(rows);
}
function renderTeamsText(game) {
  if (!game) return 'هیچ بازی‌ای فعال نیست.';
  let text = '🏆 وضعیت تیم‌ها (لایو)\n\n';
  game.teams.forEach((t, idx) => {
    const header = game.teamCount === 2 ? (idx===0 ? '🔵 تیم آبی' : '🔥 تیم قرمز') : `🏷 تیم ${idx+1}`;
    text += `${header}:\n`;
    text += `🧤 ${t.gk ?? '—'}\n`;
    t.players.forEach(p => text += `⚽ ${p}\n`);
    if (t.subs.length) { text += `🔄 تعویضی‌ها:\n`; t.subs.forEach(s => text += `▫️ ${s}\n`); }
    text += '\n';
  });
  return text;
}
async function safeUpdateGroupMessage(chatId) {
  const game = games[chatId];
  if (!game) return;
  const text = renderTeamsText(game);
  const keyboard = buildJoinKeyboard(true);
  try {
    if (game.messageId) {
      await bot.telegram.editMessageText(chatId, game.messageId, undefined, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard.reply_markup
      });
    } else {
      const sent = await bot.telegram.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard.reply_markup
      });
      game.messageId = sent.message_id;
    }
  } catch (err) {
    try {
      const sent = await bot.telegram.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: keyboard.reply_markup
      });
      game.messageId = sent.message_id;
    } catch (e2) {
      console.error('safeUpdateGroupMessage failed:', e2 && e2.message);
    }
  }
}

// ---------- /start ----------
// shows options: inside-bot or inside-group (link)
bot.start(async ctx => {
  if (ctx.chat.type === 'private') {
    const me = await bot.telegram.getMe();
    const link = `https://t.me/${me.username}?startgroup=teamchin`;
    return ctx.reply(
      '🤖 ربات «تیم‌چین» ⚽🎲\nکجا می‌خوای تیم‌چینی انجام بشه؟',
      Markup.inlineKeyboard([
        [Markup.button.callback('👤 داخل ربات', 'MODE_PRIVATE')],
        [Markup.button.callback('👥 داخل گروه (ارسال لینک)', 'MODE_SEND_LINK')]
      ])
    );
  } else {
    return ctx.reply('برای شروع تیم‌چینی ادمین دستور /start_team را اجرا کند.');
  }
});

// ---------- when bot is added to a group (auto prompt) ----------
bot.on('my_chat_member', async ctx => {
  try {
    const mc = ctx.update.my_chat_member;
    if (!mc) return;
    const newStatus = mc.new_chat_member && mc.new_chat_member.status;
    const chat = mc.chat;
    // if bot just became a member of a group or was promoted, prompt for team count
    if ((newStatus === 'member' || newStatus === 'administrator') && (chat.type === 'group' || chat.type === 'supergroup')) {
      try {
        await bot.telegram.sendMessage(chat.id, '🤖 سلام! من آماده‌ام برای تیم‌چینی. ادمین لطفاً /start_team را اجرا کند یا از منوی زیر استفاده کنید.');
      } catch (e) {
        // ignore if can't send
      }
    }
  } catch (e) {}
});

// ---------- /start_team fallback (admin-only) ----------
bot.command('start_team', async ctx => {
  if (ctx.chat.type === 'private') return ctx.reply('این دستور را داخل گروه اجرا کن.');
  try {
    const member = await bot.telegram.getChatMember(ctx.chat.id, ctx.from.id);
    if (!['creator','administrator'].includes(member.status)) return ctx.reply('⛔ فقط ادمین می‌تواند تیم‌چینی را شروع کند.');
  } catch(e){}
  return ctx.reply('🧮 چند تیم؟', Markup.inlineKeyboard([
    [Markup.button.callback('🔵 ۲ تیم', 'GROUP_TEAMS_2')],
    [Markup.button.callback('🟢 ۳ تیم', 'GROUP_TEAMS_3')],
    [Markup.button.callback('🏷 ۴ تیم', 'GROUP_TEAMS_4')]
  ]));
});

// ---------- PRIVATE MODE: user chose inside-bot ----------
bot.action('MODE_PRIVATE', async ctx => {
  await ctx.answerCbQuery();
  return ctx.editMessageText('🧮 چند تیم می‌خوای؟ (۲ تا ۴)', Markup.inlineKeyboard([
    [Markup.button.callback('🔵 ۲ تیم', 'P_TEAMS_2'), Markup.button.callback('🟢 ۳ تیم', 'P_TEAMS_3'), Markup.button.callback('🏷 ۴ تیم', 'P_TEAMS_4')]
  ]));
});

bot.action('MODE_SEND_LINK', async ctx => {
  await ctx.answerCbQuery();
  const me = await bot.telegram.getMe();
  const link = `https://t.me/${me.username}?startgroup=teamchin`;
  return ctx.reply(`👥 روی لینک بزن و ربات را به گروه بفرست، سپس در گروه یا ادمین /start_team را اجرا کند:\n\n${link}`);
});

// private: team count selected
bot.action(/P_TEAMS_(\d)/, async ctx => {
  await ctx.answerCbQuery();
  const n = Number(ctx.match[1]);
  privateSessions[ctx.from.id] = { teamCount: n };
  return ctx.reply('✍️ لطفاً نام بازیکن‌ها را با فاصله ارسال کنید (مثال: Ali Reza Sara)');
});

// private: user sends names string -> distribute randomly
bot.on('message', async ctx => {
  if (!ctx.message || !ctx.message.text) return;
  const session = privateSessions[ctx.from.id];
  if (!session) return;
  const tokens = ctx.message.text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return ctx.reply('هیچ اسمی پیدا نشد.');
  shuffleInPlace(tokens);
  const teams = Array.from({ length: session.teamCount }, () => []);
  tokens.forEach((name, i) => teams[i % session.teamCount].push(name));
  let out = '🏆 نتیجه تیم‌بندی (پی‌وی):\n\n';
  teams.forEach((t, i) => {
    out += `🔥 تیم ${i+1}:\n`;
    t.forEach(p => out += `⚽ ${p}\n`);
    out += '\n';
  });
  delete privateSessions[ctx.from.id];
  return ctx.reply(out);
});

// ---------- GROUP: choose team count handler ----------
bot.action(/GROUP_TEAMS_(\d)/, async ctx => {
  await ctx.answerCbQuery();
  const teamCount = Number(ctx.match[1]);
  const chatId = ctx.chat.id;
  await withLock(chatId, async () => {
    const teams = Array.from({ length: teamCount }, () => ({ gk: null, players: [], subs: [] }));
    games[chatId] = { teamCount, teams, users: {}, messageId: null };
    const sent = await ctx.reply('🏆 تیم‌چینی شروع شد!\nنقش خودتو انتخاب کن 👇', buildJoinKeyboard(true));
    games[chatId].messageId = sent.message_id;
  });
});

// ---------- JOIN_GK ----------
bot.action('JOIN_GK', async ctx => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  if (!games[chatId]) return ctx.answerCbQuery('بازی‌ای فعال نیست', { show_alert: true });
  await withLock(chatId, async () => {
    const game = games[chatId];
    const uid = String(ctx.from.id);
    const name = displayName(ctx.from);
    if (game.users[uid]) return ctx.answerCbQuery('❗ شما قبلاً ثبت شده‌اید');
    const available = game.teams.filter(t => t.gk === null);
    if (available.length === 0) return ctx.answerCbQuery('⛔ همه تیم‌ها دروازه‌بان دارند', { show_alert: true });
    const team = randomChoice(available);
    team.gk = name;
    game.users[uid] = { name, role: 'gk' };
    await safeUpdateGroupMessage(chatId);
    return ctx.answerCbQuery('🧤 شما به عنوان دروازه‌بان ثبت شدید');
  });
});

// ---------- JOIN_PLAYER ----------
bot.action('JOIN_PLAYER', async ctx => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  if (!games[chatId]) return ctx.answerCbQuery('بازی‌ای فعال نیست', { show_alert: true });
  await withLock(chatId, async () => {
    const game = games[chatId];
    const uid = String(ctx.from.id);
    const name = displayName(ctx.from);
    if (game.users[uid]) return ctx.answerCbQuery('❗ شما قبلاً ثبت شده‌اید');
    const available = game.teams.filter(t => t.players.length < 4);
    if (available.length > 0) {
      const team = randomChoice(available);
      team.players.push(name);
    } else {
      const team = randomChoice(game.teams);
      team.subs.push(name);
    }
    game.users[uid] = { name, role: 'player' };
    await safeUpdateGroupMessage(chatId);
    return ctx.answerCbQuery('✅ ثبت شدید');
  });
});

// ---------- RESHUFFLE (admin only) ----------
bot.action('RESHUFFLE', async ctx => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const game = games[chatId];
  if (!game) return ctx.answerCbQuery('چیزی برای قاطی کردن نیست', { show_alert: true });
  // check admin
  let isAdmin = false;
  try {
    const member = await bot.telegram.getChatMember(chatId, ctx.from.id);
    if (member && (member.status === 'creator' || member.status === 'administrator')) isAdmin = true;
  } catch (e) {}
  if (!isAdmin) return ctx.answerCbQuery('⛔ فقط ادمین می‌تواند قاطی کند', { show_alert: true });
  await withLock(chatId, async () => {
    // collect names
    const all_gks = [];
    const all_players = [];
    Object.values(game.teams).forEach(t => {
      if (t.gk) all_gks.push(t.gk);
      all_players.push(...t.players, ...t.subs);
      t.gk = null; t.players = []; t.subs = [];
    });
    shuffleInPlace(all_gks);
    shuffleInPlace(all_players);
    // assign GK randomly (one per team until run out)
    all_gks.forEach((gk, i) => {
      const idx = i % game.teamCount;
      game.teams[idx].gk = gk;
    });
    // distribute players: fill up to 4 per team randomly
    all_players.forEach(p => {
      const available = game.teams.filter(t => t.players.length < 4);
      if (available.length > 0) {
        randomChoice(available).players.push(p);
      } else {
        randomChoice(game.teams).subs.push(p);
      }
    });
    await safeUpdateGroupMessage(chatId);
    return ctx.answerCbQuery('🎲 دوباره قاطی شد');
  });
});

// ---------- boot ----------
(async () => {
  try {
    await bot.telegram.deleteWebhook().catch(()=>{});
  } catch(e){}
  bot.launch({ dropPendingUpdates: true }).then(() => {
    console.log('Bot launched (polling) — dropPendingUpdates:true');
  });
})();

// graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
