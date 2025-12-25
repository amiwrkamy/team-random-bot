// index.js — Final robust random-team bot
'use strict';

const { Telegraf, Markup } = require('telegraf');
const Redis = require('ioredis');
const express = require('express');

const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_TOKEN_HERE';
const REDIS_URL = process.env.REDIS_URL || '';
const USE_WEBHOOK = (process.env.USE_WEBHOOK || 'false').toLowerCase() === 'true';
const WEBHOOK_URL = process.env.WEBHOOK_URL || ''; // if using webhook set this
const PORT = Number(process.env.PORT || 3000);

if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_TOKEN_HERE') {
  console.error('ERROR: BOT_TOKEN is required. Set BOT_TOKEN env or replace in file.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Redis or in-memory fallback
let redis;
if (REDIS_URL) {
  redis = new Redis(REDIS_URL);
  redis.on('error', (e) => console.error('Redis error', e && e.message));
  console.log('Using Redis at', REDIS_URL);
} else {
  console.warn('No REDIS_URL provided — using in-memory sessions (non-persistent).');
  const mem = new Map();
  redis = {
    async get(k) { const v = mem.get(k); return v === undefined ? null : v; },
    async set(k,v) { mem.set(k,v); return 'OK'; },
    async del(k) { mem.delete(k); return 1; }
  };
}

const SESSION_PREFIX = 'rtb:sess:';
const sessionKey = (chatId) => `${SESSION_PREFIX}${chatId}`;

// session helpers
async function loadSession(chatId) {
  const raw = await redis.get(sessionKey(chatId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { console.error('session parse err', e); return null; }
}
async function saveSession(chatId, sess) {
  await redis.set(sessionKey(chatId), JSON.stringify(sess));
}
async function delSession(chatId) { await redis.del(sessionKey(chatId)); }

// utils
function shuffle(arr) {
  for (let i = arr.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// session model for group
// { type:'group', teamsCount, teams: [ { members:[], subs:[] } ], membersMap: { userId:true }, signupOpen:true, message_id:null, creator }

function createEmptyGroupSession(teamsCount, creator) {
  const teams = Array.from({length:teamsCount}, ()=>({ members:[], subs:[] }));
  return { type:'group', teamsCount, teams, membersMap:{}, signupOpen:true, message_id:null, creator: creator||null };
}

// build keyboards
function groupReplyMarkupObj() {
  return Markup.inlineKeyboard([
    [ Markup.button.callback('⚽ بازیکن', 'join:player'), Markup.button.callback('🥅 دروازه‌بان', 'join:gk') ],
    [ Markup.button.callback('🔀 قاطی‌کردن دوباره (فقط ادمین)', 'action:reshuffle') ]
  ]).reply_markup;
}
function startModeKeyboard() {
  return Markup.inlineKeyboard([
    [ Markup.button.callback('🤖 داخل ربات', 'mode:inside_bot') ],
    [ Markup.button.callback('👥 داخل گروه', 'mode:inside_group') ]
  ]);
}
function teamsKeyboard(prefix='') {
  return Markup.inlineKeyboard([
    [ Markup.button.callback('2️⃣  2 تیم', `${prefix}teams:2`) ],
    [ Markup.button.callback('3️⃣  3 تیم', `${prefix}teams:3`) ],
    [ Markup.button.callback('4️⃣  4 تیم', `${prefix}teams:4`) ]
  ]);
}

// build live text for group
function buildGroupText(sess) {
  let out = '<b>🏆 وضعیت تیم‌ها (لایو)</b>\n\n';
  for (let i=0;i<sess.teamsCount;i++){
    const team = sess.teams[i];
    const color = ['🔵','🟢','🟠','🟣'][i%4];
    out += `${color} <b>تیم ${i+1}</b> — ${team.members.length} نفر\n`;
    if (team.members.length === 0) out += '—\n';
    else {
      for (const m of team.members) {
        const icon = m.role==='gk' ? '🧤' : '⚽';
        out += `${icon} ${escapeHtml(m.name)}\n`;
      }
    }
    if (team.subs && team.subs.length) {
      out += `\n🔄 <b>تعویضی‌های تیم ${i+1}:</b>\n`;
      for (const s of team.subs) out += `↳ ${escapeHtml(s.name)}\n`;
    }
    out += '\n';
  }
  out += '<b>📌 هر نفر فقط یک‌بار می‌تواند ثبت‌نام کند.</b>\n';
  out += '<b>👑 فقط ادمین می‌تواند «🔀 قاطی‌کردن دوباره» را اجرا کند.</b>';
  return out;
}

// assignment logic: when a player joins, assign to a team
function assignPlayerToTeam(sess, userId, name) {
  // find minimal members count <5
  let minSize = Infinity;
  for (let i=0;i<sess.teamsCount;i++){
    const len = sess.teams[i].members.length;
    if (len < minSize && len < 5) minSize = len;
  }
  const eligible = [];
  for (let i=0;i<sess.teamsCount;i++){
    if (sess.teams[i].members.length === minSize && sess.teams[i].members.length < 5) eligible.push(i);
  }
  if (eligible.length > 0) {
    const pick = eligible[Math.floor(Math.random()*eligible.length)];
    sess.teams[pick].members.push({ id:userId, name, role:'player' });
    sess.membersMap[String(userId)] = true;
    return { placed:true, team:pick };
  }
  // all teams full (members >=5) -> add to subs of team with minimal subs
  let minSubs = Infinity; let chosen = 0;
  for (let i=0;i<sess.teamsCount;i++){
    const s = sess.teams[i].subs.length;
    if (s < minSubs) { minSubs = s; chosen = i; }
  }
  sess.teams[chosen].subs.push({ id:userId, name, role:'player' });
  sess.membersMap[String(userId)] = true;
  return { placed:false, team:chosen };
}

function assignGkToTeam(sess, userId, name) {
  const available = [];
  for (let i=0;i<sess.teamsCount;i++){
    const hasGK = sess.teams[i].members.some(m => m.role==='gk');
    if (!hasGK && sess.teams[i].members.length < 5) available.push(i);
  }
  if (available.length === 0) return null;
  const pick = available[Math.floor(Math.random()*available.length)];
  sess.teams[pick].members.push({ id:userId, name, role:'gk' });
  sess.membersMap[String(userId)] = true;
  return { team:pick };
}

// reshuffle: collect GK and players (members+subs) and redistribute
function reshuffleSession(sess) {
  const gks = [];
  const players = [];
  for (let i=0;i<sess.teamsCount;i++){
    for (const m of sess.teams[i].members) {
      if (m.role === 'gk') gks.push({ id:m.id, name:m.name });
      else players.push({ id:m.id, name:m.name });
    }
    for (const s of sess.teams[i].subs) players.push({ id:s.id, name:s.name });
  }
  if (gks.length < sess.teamsCount) return { ok:false, reason:'not_enough_gk' };
  shuffle(gks);
  shuffle(players);
  const newTeams = Array.from({length:sess.teamsCount}, ()=>({ members:[], subs:[] }));
  for (let i=0;i<sess.teamsCount;i++){
    newTeams[i].members.push({ id:gks[i].id, name:gks[i].name, role:'gk' });
  }
  let idx = 0;
  for (const p of players){
    const t = idx % sess.teamsCount;
    if (newTeams[t].members.length < 5) newTeams[t].members.push({ id:p.id, name:p.name, role:'player' });
    else newTeams[t].subs.push({ id:p.id, name:p.name, role:'player' });
    idx++;
  }
  sess.teams = newTeams;
  // rebuild membersMap
  sess.membersMap = {};
  for (let i=0;i<sess.teamsCount;i++){
    for (const m of sess.teams[i].members) if (m.id) sess.membersMap[String(m.id)]=true;
    for (const s of sess.teams[i].subs) if (s.id) sess.membersMap[String(s.id)]=true;
  }
  return { ok:true };
}

// update or send live message
async function updateGroupStatusMessage(chatId, sess) {
  const text = buildGroupText(sess);
  const reply_markup = groupReplyMarkupObj();
  try {
    if (sess.message_id) {
      await bot.telegram.editMessageText(chatId, sess.message_id, null, text, { parse_mode:'HTML', reply_markup });
    } else {
      const sent = await bot.telegram.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup });
      sess.message_id = sent.message_id;
    }
  } catch (err) {
    console.warn('edit failed, sending new. err:', err && err.message);
    const sent = await bot.telegram.sendMessage(chatId, text, { parse_mode:'HTML', reply_markup });
    sess.message_id = sent.message_id;
  }
  await saveSession(chatId, sess);
}

// ---------- Bot handlers ----------

// /start
bot.start(async (ctx) => {
  try {
    if (ctx.chat.type === 'private') {
      await ctx.reply('سلام! کجا می‌خوای تیم‌چینی انجام بشه؟', startModeKeyboard());
    } else {
      await ctx.reply('برای شروع تیم‌چینی ادمین گروه /start_team را اجرا کند.');
    }
  } catch (e) { console.error('start err', e); }
});

// /start_team (group only) - admin only
bot.command('start_team', async (ctx) => {
  if (ctx.chat.type === 'private') return ctx.reply('این دستور تنها در گروه اجرا می‌شود.');
  try {
    const admins = await ctx.getChatAdministrators();
    if (!admins.some(a => a.user.id === ctx.from.id)) return ctx.reply('⛔ فقط ادمین می‌تواند این دستور را اجرا کند.');
  } catch(e) { console.warn('admin check err', e); }
  await ctx.reply('🔢 چند تیم می‌خواهی؟', teamsKeyboard());
});

// callback queries
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery && ctx.callbackQuery.data;
  const from = ctx.from;
  const message = ctx.callbackQuery && ctx.callbackQuery.message;
  try {
    // Mode selection in private
    if (data === 'mode:inside_bot') {
      await ctx.answerCbQuery();
      return ctx.reply('در حالت داخل ربات — چند تیم؟', teamsKeyboard('private:'));
    }
    if (data === 'mode:inside_group') {
      await ctx.answerCbQuery();
      const me = await bot.telegram.getMe();
      const url = `https://t.me/${me.username}?startgroup=true`;
      return ctx.replyWithHTML(`برای اضافه کردن ربات به گروه از لینک زیر استفاده کنید:\n<a href="${url}">اضافه کردن ربات به گروه</a>`);
    }

    // private teams selection
    if (data && data.startsWith('private:teams:')) {
      await ctx.answerCbQuery();
      const num = Number(data.split(':').pop());
      const sess = { type:'private', teamsCount:num, awaitingNames:true, creator: from.id };
      await saveSession(ctx.chat.id, sess);
      return ctx.reply(`<b>در حالت داخل ربات — تعداد تیم‌ها: ${num}</b>\n\nلطفاً اسامی را هر کدام در یک خط ارسال کنید.\nتوضیح: ${num} نام اول به عنوان دروازه‌بان در نظر گرفته می‌شوند.`, { parse_mode:'HTML' });
    }

    // group teams selection
    if (data && data.startsWith('teams:')) {
      await ctx.answerCbQuery();
      const num = Number(data.split(':').pop());
      const chatId = message.chat.id;
      try {
        const admins = await bot.telegram.getChatAdministrators(chatId);
        if (!admins.some(a=>a.user.id === from.id)) {
          return ctx.reply('⛔ فقط ادمین می‌تواند تعداد تیم‌ها را انتخاب کند.');
        }
      } catch (e) { console.warn('admin check err', e); }
      const sess = createEmptyGroupSession(num, from.id);
      await saveSession(chatId, sess);
      await updateGroupStatusMessage(chatId, sess);
      return;
    }

    // join player
    if (data === 'join:player') {
      await ctx.answerCbQuery();
      const chatId = message.chat.id;
      const sess = await loadSession(chatId);
      if (!sess || !sess.signupOpen) return ctx.answerCbQuery('ثبت‌نام فعال نیست.', { show_alert:true });
      if (sess.membersMap && sess.membersMap[String(from.id)]) return ctx.answerCbQuery('شما قبلاً ثبت‌نام کرده‌اید.', { show_alert:true });
      const name = from.username ? `@${from.username}` : (from.first_name || `${from.id}`);
      const res = assignPlayerToTeam(sess, from.id, name);
      await saveSession(chatId, sess);
      await updateGroupStatusMessage(chatId, sess);
      return ctx.answerCbQuery(res.placed ? `✅ شما در تیم ${res.team+1} ثبت شدید.` : `✅ شما به تعویضی تیم ${res.team+1} اضافه شدید.`);
    }

    // join gk
    if (data === 'join:gk') {
      await ctx.answerCbQuery();
      const chatId = message.chat.id;
      const sess = await loadSession(chatId);
      if (!sess || !sess.signupOpen) return ctx.answerCbQuery('ثبت‌نام فعال نیست.', { show_alert:true });
      if (sess.membersMap && sess.membersMap[String(from.id)]) return ctx.answerCbQuery('شما قبلاً ثبت‌نام کرده‌اید.', { show_alert:true });
      const name = from.username ? `@${from.username}` : (from.first_name || `${from.id}`);
      const res = assignGkToTeam(sess, from.id, name);
      if (!res) {
        await saveSession(chatId, sess);
        await updateGroupStatusMessage(chatId, sess);
        return ctx.answerCbQuery('دروازه‌بان قابل ثبت نیست (همه تیم‌ها GK دارند یا پر هستند).', { show_alert:true });
      }
      await saveSession(chatId, sess);
      await updateGroupStatusMessage(chatId, sess);
      return ctx.answerCbQuery(`✅ شما دروازه‌بان تیم ${res.team+1} شدید.`);
    }

    // reshuffle (admin only)
    if (data === 'action:reshuffle') {
      await ctx.answerCbQuery();
      const chatId = message.chat.id;
      const sess = await loadSession(chatId);
      if (!sess) return ctx.answerCbQuery();
      try {
        const admins = await bot.telegram.getChatAdministrators(chatId);
        if (!admins.some(a=>a.user.id === from.id)) {
          return ctx.answerCbQuery('⚠️ فقط ادمین می‌تواند این کار را انجام دهد.', { show_alert:true });
        }
      } catch(e) { console.warn('admin check err', e); }
      const r = reshuffleSession(sess);
      if (!r.ok) {
        await saveSession(chatId, sess);
        await updateGroupStatusMessage(chatId, sess);
        return ctx.answerCbQuery('⚠️ قاطی‌کردن دوباره امکان‌پذیر نیست — دروازه‌بان‌ها کافی نیستند.', { show_alert:true });
      }
      await saveSession(chatId, sess);
      await updateGroupStatusMessage(chatId, sess);
      return ctx.answerCbQuery('🔀 بازچینش انجام شد.');
    }

    await ctx.answerCbQuery();
  } catch (err) {
    console.error('callback_query err', err && err.message);
    try { await ctx.answerCbQuery('❌ خطا — دوباره تلاش کنید', { show_alert:true }); } catch(e){}
  }
});

// private message handler: names input for inside-bot flow
bot.on('message', async (ctx) => {
  try {
    if (ctx.chat.type !== 'private') return;
    const sess = await loadSession(ctx.chat.id);
    if (!sess || sess.type !== 'private' || !sess.awaitingNames) return;
    const text = (ctx.message.text || '').trim();
    if (!text) return ctx.reply('لطفاً اسامی را هر کدام در یک سطر ارسال کنید.');
    const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
    const teamsCount = sess.teamsCount;
    if (lines.length < teamsCount) return ctx.reply(`لطفاً حداقل ${teamsCount} نام ارسال کنید — ${teamsCount} نام اول دروازه‌بان هستند.`);
    const gkNames = lines.slice(0, teamsCount);
    const playerNames = lines.slice(teamsCount);
    shuffle(gkNames); shuffle(playerNames);
    // build teams
    const teams = Array.from({length:teamsCount}, ()=>({ members:[], subs:[] }));
    for (let i=0;i<teamsCount;i++) teams[i].members.push({ id:null, name:gkNames[i], role:'gk' });
    let idx=0;
    for (const pname of playerNames) {
      const t = idx % teamsCount;
      if (teams[t].members.length < 5) teams[t].members.push({ id:null, name:pname, role:'player' });
      else teams[t].subs.push({ id:null, name:pname, role:'player' });
      idx++;
    }
    // output
    let out = '<b>🏆 نتیجهٔ داخل ربات (شانسی)</b>\n\n';
    for (let i=0;i<teamsCount;i++){
      out += `<b>🔹 تیم ${i+1} — ${teams[i].members.length} نفر</b>\n`;
      for (const m of teams[i].members) out += `${m.role==='gk' ? '🧤' : '⚽'} ${escapeHtml(m.name)}\n`;
      if (teams[i].subs.length) {
        out += `<b>🔄 تعویضی‌های تیم ${i+1}:</b>\n`;
        for (const s of teams[i].subs) out += `↳ ${escapeHtml(s.name)}\n`;
      }
      out += '\n';
    }
    await ctx.reply(out, { parse_mode:'HTML' });
    sess.awaitingNames = false;
    await saveSession(ctx.chat.id, sess);
  } catch (err) {
    console.error('private message handler err', err && err.message);
  }
});

// start bot (polling or webhook)
(async function startBot(){
  try {
    if (USE_WEBHOOK && WEBHOOK_URL) {
      const app = express();
      app.use(express.json());
      app.post('/telegram-webhook', (req,res) => {
        bot.handleUpdate(req.body).then(()=>res.status(200).end()).catch(e=>{ console.error(e); res.status(500).end(); });
      });
      app.get('/healthz', (req,res)=>res.send('OK'));
      app.listen(PORT, async ()=> {
        console.log('Express listening on', PORT);
        try {
          await bot.telegram.setWebhook(WEBHOOK_URL);
          console.log('Webhook set to', WEBHOOK_URL);
        } catch(e) { console.error('setWebhook error', e && e.message); }
      });
    } else {
      try { await bot.telegram.deleteWebhook(); } catch(e){}
      await bot.launch();
      console.log('Bot launched (polling)');
    }
  } catch (e) {
    console.error('startBot error', e && e.message);
    try { await bot.launch(); } catch(err) { console.error('launch fallback failed', err); process.exit(1); }
  }
})();

process.on('unhandledRejection', (r)=>console.error('unhandledRejection',r));
process.on('uncaughtException', (e)=>{ console.error('uncaughtException', e && e.stack || e); process.exit(1); });

module.exports = { bot, redis };
