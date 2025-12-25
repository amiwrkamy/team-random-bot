// index.js
'use strict';

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const Redis = require('ioredis');

const BOT_TOKEN = process.env.BOT_TOKEN;
const REDIS_URL = process.env.REDIS_URL || '';
const USE_WEBHOOK = false; // ما در این نسخه فقط polling استفاده می‌کنیم
const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;

if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN environment variable is required.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// ---------- storage (Redis optional, fallback in-memory) ----------
let redis;
let usingRedis = false;
if (REDIS_URL) {
  redis = new Redis(REDIS_URL);
  usingRedis = true;
  redis.on('error', (e) => console.error('Redis error', e && e.message));
  console.log('Using Redis at', REDIS_URL);
} else {
  console.warn('Warning: REDIS_URL not provided. Using in-memory sessions (non-persistent).');
  const mem = new Map();
  redis = {
    async get(k) { const v = mem.get(k); return v === undefined ? null : v; },
    async set(k, v) { mem.set(k, v); return 'OK'; },
    async del(k) { mem.delete(k); return 1; }
  };
}

// ---------- session helpers ----------
const SESSION_PREFIX = 'rtb:sess:';
const sessionKey = (chatId) => `${SESSION_PREFIX}${chatId}`;

async function loadSession(chatId) {
  const raw = await redis.get(sessionKey(chatId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { console.error('parse session error', e); return null; }
}
async function saveSession(chatId, sess) {
  await redis.set(sessionKey(chatId), JSON.stringify(sess));
}

// ---------- utilities ----------
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ---------- model & helpers (برگرفته از کد مرجع خودت) ----------
function createEmptyGroupSession(teamsCount, creator) {
  const teams = Array.from({ length: teamsCount }, () => ({ members: [], subs: [] }));
  return { type: 'group', teamsCount, teams, membersMap: {}, signupOpen: true, message_id: null, creator: creator || null };
}

function groupKeyboardReplyMarkup() {
  return Markup.inlineKeyboard([
    [ Markup.button.callback('⚽ بازیکن', 'join:player'), Markup.button.callback('🥅 دروازه‌بان', 'join:gk') ],
    [ Markup.button.callback('🔀 قاطی‌کردن دوباره (فقط ادمین)', 'action:reshuffle') ]
  ]).reply_markup;
}

function buildGroupText(sess) {
  let out = '<b>🏆 وضعیت تیم‌ها (لایو)</b>\n\n';
  for (let i = 0; i < sess.teamsCount; i++) {
    const t = sess.teams[i];
    const color = ['🔵','🟢','🟠','🟣'][i % 4];
    out += `${color} <b>تیم ${i+1}</b> — ${t.members.length} نفر\n`;
    if (t.members.length === 0) out += '—\n';
    else {
      for (const m of t.members) {
        const icon = (m.role === 'gk') ? '🧤' : '⚽';
        out += `${icon} ${escapeHtml(m.name)}\n`;
      }
    }
    if (t.subs && t.subs.length) {
      out += `\n🔄 <b>تعویضی‌های تیم ${i+1}:</b>\n`;
      for (const s of t.subs) out += `↳ ${escapeHtml(s.name)}\n`;
    }
    out += '\n';
  }
  out += '<b>📌 هر نفر فقط یک‌بار می‌تواند ثبت‌نام کند.</b>\n';
  out += '<b>👑 فقط ادمین می‌تواند «🔀 قاطی‌کردن دوباره» را اجرا کند.</b>';
  return out;
}

function assignPlayerToTeam(sess, userId, name) {
  let minSize = Infinity;
  for (let i = 0; i < sess.teamsCount; i++) {
    const size = sess.teams[i].members.length;
    if (size < minSize && size < 5) minSize = size;
  }
  const candidates = [];
  for (let i = 0; i < sess.teamsCount; i++) {
    if (sess.teams[i].members.length === minSize && sess.teams[i].members.length < 5) candidates.push(i);
  }
  if (candidates.length > 0) {
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    sess.teams[pick].members.push({ id: userId, name, role: 'player' });
    sess.membersMap[String(userId)] = true;
    return { placed: true, team: pick };
  }
  let minSubs = Infinity; let chosen = 0;
  for (let i = 0; i < sess.teamsCount; i++) {
    const s = sess.teams[i].subs.length;
    if (s < minSubs) { minSubs = s; chosen = i; }
  }
  sess.teams[chosen].subs.push({ id: userId, name, role: 'player' });
  sess.membersMap[String(userId)] = true;
  return { placed: false, team: chosen };
}

function assignGkToTeam(sess, userId, name) {
  const available = [];
  for (let i = 0; i < sess.teamsCount; i++) {
    const hasGK = sess.teams[i].members.some(m => m.role === 'gk');
    if (!hasGK && sess.teams[i].members.length < 5) available.push(i);
  }
  if (available.length === 0) return null;
  const pick = available[Math.floor(Math.random() * available.length)];
  sess.teams[pick].members.push({ id: userId, name, role: 'gk' });
  sess.membersMap[String(userId)] = true;
  return { team: pick };
}

function reshuffleSession(sess) {
  const gks = [];
  const players = [];
  for (let i = 0; i < sess.teamsCount; i++) {
    for (const m of sess.teams[i].members) {
      if (m.role === 'gk') gks.push({ id: m.id, name: m.name });
      else players.push({ id: m.id, name: m.name });
    }
    for (const s of sess.teams[i].subs) players.push({ id: s.id, name: s.name });
  }
  if (gks.length < sess.teamsCount) return { ok: false, reason: 'not_enough_gk' };

  shuffle(gks);
  shuffle(players);

  const newTeams = Array.from({ length: sess.teamsCount }, () => ({ members: [], subs: [] }));
  for (let i = 0; i < sess.teamsCount; i++) {
    newTeams[i].members.push({ id: gks[i].id, name: gks[i].name, role: 'gk' });
  }
  let idx = 0;
  for (const p of players) {
    const teamIdx = idx % sess.teamsCount;
    if (newTeams[teamIdx].members.length < 5) {
      newTeams[teamIdx].members.push({ id: p.id, name: p.name, role: 'player' });
    } else {
      newTeams[teamIdx].subs.push({ id: p.id, name: p.name, role: 'player' });
    }
    idx++;
  }

  sess.teams = newTeams;
  return { ok: true };
}

// ---------- message updater (با هندل خطا) ----------
async function updateGroupMessage(chatId, sess) {
  const text = buildGroupText(sess);
  const reply_markup = groupKeyboardReplyMarkup();
  try {
    if (sess.message_id) {
      try {
        await bot.telegram.editMessageText(chatId, sess.message_id, null, text, { parse_mode: 'HTML', reply_markup });
      } catch (err) {
        // اگر پیام تغییری نکرده یا خطای edit داد -> یک پیام جدید بفرست
        const msg = String(err && err.description || err.message || '');
        if (msg.includes('message is not modified')) {
          // هیچ کاری نکنیم (ممکنه کاربر دوباره زده باشه)
          // ولی برای اطمینان سشن رو ذخیره میکنیم
          await saveSession(chatId, sess);
          return;
        }
        console.error('updateGroupMessage edit failed, sending new.', err && err.message);
        const sent = await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
        sess.message_id = sent.message_id;
      }
    } else {
      const sent = await bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup });
      sess.message_id = sent.message_id;
    }
  } catch (err) {
    console.error('updateGroupMessage failed sending new', err && err.message);
  }
  await saveSession(chatId, sess);
}

// ---------- bot handlers (استارت + گروه) ----------
bot.start(async (ctx) => {
  const chat = ctx.chat;
  if (chat.type === 'private') {
    await ctx.reply('سلام! کجا می‌خوای تیم‌چینی انجام بشه؟', Markup.inlineKeyboard([
      [ Markup.button.callback('🤖 داخل ربات', 'mode:inside_bot') ],
      [ Markup.button.callback('👥 داخل گروه', 'mode:inside_group') ]
    ]));
  } else {
    await ctx.reply('برای شروع تیم‌چینی ادمین گروه دستور /start_team را ارسال کند.');
  }
});

bot.command('start_team', async (ctx) => {
  if (ctx.chat.type === 'private') return ctx.reply('این دستور فقط در گروه اجرا می‌شود.');
  try {
    const admins = await ctx.getChatAdministrators();
    const isAdmin = admins.some(a => a.user.id === ctx.from.id);
    if (!isAdmin) return ctx.reply('⛔ فقط ادمین می‌تواند این دستور را اجرا کند.');
  } catch (e) { console.error('admin check error', e); }
  await ctx.reply('🔢 چند تیم می‌خواهی؟', Markup.inlineKeyboard([
    [ Markup.button.callback('2️⃣  2 تیم', 'teams:2'), Markup.button.callback('3️⃣  3 تیم', 'teams:3') ],
    [ Markup.button.callback('4️⃣  4 تیم', 'teams:4') ]
  ]));
});

// callback query
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery && ctx.callbackQuery.data;
  const from = ctx.from;
  const message = ctx.callbackQuery && ctx.callbackQuery.message;
  try {
    if (!data) return ctx.answerCbQuery();

    // حالت داخل ربات
    if (data === 'mode:inside_bot') {
      await ctx.answerCbQuery();
      return ctx.reply('در حالت داخل ربات — چند تیم؟', Markup.inlineKeyboard([
        [ Markup.button.callback('2️⃣  2 تیم', 'private:teams:2') ],
        [ Markup.button.callback('3️⃣  3 تیم', 'private:teams:3') ],
        [ Markup.button.callback('4️⃣  4 تیم', 'private:teams:4') ]
      ]));
    }
    if (data === 'mode:inside_group') {
      await ctx.answerCbQuery();
      const me = await bot.telegram.getMe();
      const url = `https://t.me/${me.username}?startgroup=true`;
      return ctx.replyWithHTML(`برای اضافه کردن ربات به گروه از لینک زیر استفاده کنید:\n<a href="${url}">اضافه کردن ربات به گروه</a>`);
    }

    if (data && data.startsWith('private:teams:')) {
      await ctx.answerCbQuery();
      const num = Number(data.split(':').pop());
      const sess = { type: 'private', teamsCount: num, awaitingNames: true, creator: from.id };
      await saveSession(ctx.chat.id, sess);
      return ctx.reply(`<b>حالت داخل ربات — تعداد تیم‌ها: ${num}</b>\n\nلطفاً اسامی را هر کدام در یک خط ارسال کنید.\nتوضیح: <i>${num}</i> نام اول به عنوان دروازه‌بان در نظر گرفته می‌شود.`, { parse_mode: 'HTML' });
    }

    if (data && data.startsWith('teams:')) {
      await ctx.answerCbQuery();
      const num = Number(data.split(':').pop());
      const chatId = message.chat.id;
      try {
        const admins = await bot.telegram.getChatAdministrators(chatId);
        if (!admins.some(a => a.user.id === from.id)) {
          return ctx.reply('⛔ فقط ادمین می‌تواند تعداد تیم‌ها را انتخاب کند.');
        }
      } catch (e) { console.error('admin check error', e); }
      const sess = createEmptyGroupSession(num, from.id);
      await saveSession(chatId, sess);
      await updateGroupMessage(chatId, sess);
      return;
    }

    if (data === 'join:player') {
      await ctx.answerCbQuery();
      const chatId = message.chat.id;
      const sess = await loadSession(chatId);
      if (!sess || !sess.signupOpen) return ctx.answerCbQuery('ثبت‌نام فعالی وجود ندارد.', { show_alert: true });
      if (sess.membersMap && sess.membersMap[String(from.id)]) return ctx.answerCbQuery('شما قبلاً ثبت‌نام کرده‌اید.', { show_alert: true });
      const name = from.username ? `@${from.username}` : (from.first_name || `${from.id}`);
      const res = assignPlayerToTeam(sess, from.id, name);
      await saveSession(chatId, sess);
      await updateGroupMessage(chatId, sess);
      if (res.placed) return ctx.answerCbQuery(`✅ شما در تیم ${res.team + 1} ثبت شدید.`);
      else return ctx.answerCbQuery(`✅ شما به تعویضی تیم ${res.team + 1} اضافه شدید.`);
    }

    if (data === 'join:gk') {
      await ctx.answerCbQuery();
      const chatId = message.chat.id;
      const sess = await loadSession(chatId);
      if (!sess || !sess.signupOpen) return ctx.answerCbQuery('ثبت‌نام فعالی وجود ندارد.', { show_alert: true });
      if (sess.membersMap && sess.membersMap[String(from.id)]) return ctx.answerCbQuery('شما قبلاً ثبت‌نام کرده‌اید.', { show_alert: true });
      const name = from.username ? `@${from.username}` : (from.first_name || `${from.id}`);
      const res = assignGkToTeam(sess, from.id, name);
      if (!res) {
        await saveSession(chatId, sess);
        await updateGroupMessage(chatId, sess);
        return ctx.answerCbQuery('تعداد دروازه‌بان‌ها تکمیل شده یا تیم مناسب وجود ندارد.', { show_alert: true });
      }
      await saveSession(chatId, sess);
      await updateGroupMessage(chatId, sess);
      return ctx.answerCbQuery(`✅ شما دروازه‌بان تیم ${res.team + 1} شدید.`);
    }

    if (data === 'action:reshuffle') {
      await ctx.answerCbQuery();
      const chatId = message.chat.id;
      const sess = await loadSession(chatId);
      if (!sess) return ctx.answerCbQuery();
      try {
        const admins = await bot.telegram.getChatAdministrators(chatId);
        if (!admins.some(a => a.user.id === from.id)) {
          return ctx.answerCbQuery('⚠️ فقط ادمین می‌تواند این کار را انجام دهد.', { show_alert: true });
        }
      } catch (e) { console.error('admin check error', e); }
      const r = reshuffleSession(sess);
      if (!r.ok) {
        await saveSession(chatId, sess);
        await updateGroupMessage(chatId, sess);
        return ctx.answerCbQuery('⚠️ قاطی‌کردن دوباره امکان‌پذیر نیست — تعداد دروازه‌بان‌ها کافی نیست.', { show_alert: true });
      }
      await saveSession(chatId, sess);
      await updateGroupMessage(chatId, sess);
      return ctx.answerCbQuery('🔀 بازچینش انجام شد.');
    }

    await ctx.answerCbQuery();
  } catch (err) {
    console.error('callback_query error', err && err.message);
    try { await ctx.answerCbQuery('❌ خطا — مجدداً تلاش کنید', { show_alert: true }); } catch(e){}
  }
});

// private message handler (داخل ربات اسامی را می‌گیرد)
bot.on('message', async (ctx) => {
  try {
    const chat = ctx.chat;
    if (chat.type !== 'private') return;
    const sess = await loadSession(chat.id);
    if (!sess || sess.type !== 'private' || !sess.awaitingNames) return;
    const text = (ctx.message.text || '').trim();
    if (!text) return ctx.reply('لطفاً اسامی را هر کدام در یک خط ارسال کنید.');
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const teamsCount = sess.teamsCount;
    if (lines.length < teamsCount) {
      return ctx.reply(`لطفاً حداقل ${teamsCount} نام ارسال کنید — ${teamsCount} نام اول به عنوان دروازه‌بان در نظر گرفته می‌شوند.`);
    }
    const gkNames = lines.slice(0, teamsCount);
    const playerNames = lines.slice(teamsCount);
    shuffle(gkNames);
    shuffle(playerNames);
    const teams = Array.from({ length: teamsCount }, () => ({ members: [], subs: [] }));
    for (let i = 0; i < teamsCount; i++) teams[i].members.push({ id: null, name: gkNames[i], role: 'gk' });
    let idx = 0;
    for (const pname of playerNames) {
      const tIdx = idx % teamsCount;
      if (teams[tIdx].members.length < 5) teams[tIdx].members.push({ id: null, name: pname, role: 'player' });
      else teams[tIdx].subs.push({ id: null, name: pname, role: 'player' });
      idx++;
    }
    let out = '<b>🏆 نتیجهٔ داخل ربات (شانسی)</b>\n\n';
    for (let i = 0; i < teamsCount; i++) {
      out += `<b>🔹 تیم ${i + 1} — ${teams[i].members.length} نفر</b>\n`;
      for (const m of teams[i].members) out += `${m.role === 'gk' ? '🧤' : '⚽'} ${escapeHtml(m.name)}\n`;
      if (teams[i].subs.length) {
        out += `<b>🔄 تعویضی‌های تیم ${i + 1}:</b>\n`;
        for (const s of teams[i].subs) out += `↳ ${escapeHtml(s.name)}\n`;
      }
      out += '\n';
    }
    await ctx.reply(out, { parse_mode: 'HTML' });
    sess.awaitingNames = false;
    await saveSession(chat.id, sess);
  } catch (err) {
    console.error('private message handler error', err && err.message);
  }
});

// ---------- start logic: avoid multiple launches, handle 409 with retry ----------
let isLaunched = false;
async function startPollingWithRetry() {
  if (isLaunched) return;
  let attempt = 0;
  const maxDelay = 60 * 1000; // حداکثر 60s بین تلاش‌ها
  while (!isLaunched) {
    attempt++;
    try {
      // Make sure webhook is deleted (safe)
      try {
        await bot.telegram.deleteWebhook();
      } catch (e) {
        // ignore
      }
      await bot.launch({ dropPendingUpdates: true });
      isLaunched = true;
      console.log('✅ Bot launched (polling).');
      break;
    } catch (err) {
      console.error(`start attempt #${attempt} failed:`, err && (err.description || err.message || err));
      // If 409 -> conflict, wait and retry
      const is409 = err && (err.code === 409 || (err.description && err.description.includes('409')));
      if (!is409) {
        // اگر خطای دیگریه به جای ریترای خارج میشیم (اما در عمل تلاش مجدد هم میشود)
      }
      const delay = Math.min(1000 * Math.pow(2, Math.min(attempt, 6)), maxDelay);
      console.log(`Retrying start in ${delay/1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  // graceful shutdown hooks
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

// ---------- optional minimal web server so Render happy باشد (listen only, no webhook) ----------
function startHttpServer() {
  const app = express();
  app.get('/', (req, res) => res.send('OK - random team bot'));
  const server = app.listen(PORT, () => {
    console.log(`HTTP server running on port ${PORT}`);
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${PORT} already in use — continuing without http server (ok for polling).`);
    } else {
      console.error('HTTP server error', err && err.message);
    }
  });
}

// ---------- boot sequence ----------
(async () => {
  try {
    startHttpServer();
  } catch (e) {
    console.error('startHttpServer error', e && e.message);
  }
  // small delay to allow server settle
  setTimeout(() => {
    startPollingWithRetry().catch((e) => console.error('startPollingWithRetry failed', e));
  }, 300);
})();

// global error handlers
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err && (err.stack || err));
  // exit? keep running — Render will restart on crash. Here we log and exit to let host restart.
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
});
