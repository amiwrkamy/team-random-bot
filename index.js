// index.js - resilient version
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN missing in environment variables.');
  process.exit(1);
}

const DATA_FILE = process.env.DATA_FILE || path.join(process.cwd(), 'data.json');
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(process.cwd(), 'backups');
const PORT = process.env.PORT || 3000;

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ========== simple atomic JSON persistence ==========
function safeWriteFileSync(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8' });
  fs.renameSync(tmp, filePath);
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const base = { chats: {}, meta: { createdAt: Date.now() } };
      safeWriteFileSync(DATA_FILE, base);
      return base;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to load data:', e);
    // on corruption: move broken file and create fresh with backup
    const broken = DATA_FILE + '.broken.' + Date.now();
    try { fs.renameSync(DATA_FILE, broken); } catch {}
    const base = { chats: {}, meta: { createdAt: Date.now() } };
    safeWriteFileSync(DATA_FILE, base);
    return base;
  }
}

function saveDataSync(data) {
  try {
    safeWriteFileSync(DATA_FILE, data);
  } catch (e) {
    console.error('Failed to save data:', e);
  }
}

// periodic backup
cron.schedule('*/5 * * * *', () => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const to = path.join(BACKUP_DIR, `data-backup-${stamp}.json`);
    fs.copyFileSync(DATA_FILE, to);
    console.log('Backup saved to', to);
  } catch (e) {
    console.error('Backup failed:', e);
  }
});

// ========== utils ==========
function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}
function displayName(user) {
  if (!user) return '—';
  if (user.username) return '@' + user.username;
  if (user.first_name && user.last_name) return `${user.first_name} ${user.last_name}`;
  return user.first_name || `${user.id}`;
}

// simple mutex per chat to prevent race conditions
const locks = new Map();
async function acquire(chatId) {
  while (locks.get(chatId)) {
    // busy-wait small delay
    await new Promise(r => setTimeout(r, 30));
  }
  locks.set(chatId, true);
}
function release(chatId) { locks.delete(chatId); }

// load persistent storage into memory
const store = loadData(); // { chats: { chatId: {...} }, meta: {} }

// ========== Bot logic (stateful) ==========
const bot = new Telegraf(BOT_TOKEN);

// ensure chat state exists
function ensureChatState(chatId, teamsCount = 2) {
  const key = String(chatId);
  if (!store.chats[key]) {
    store.chats[key] = {
      chatId: key,
      teamsCount,
      teams: Array.from({ length: teamsCount }, () => []), // each item: {id, name, role}
      substitutes: [],
      registered: {}, // userId -> {id,name,role,teamIndex}
      message_id: null,
      adminIds: [], // store admin ids known
      lastUpdated: Date.now()
    };
    saveDataSync(store);
  } else {
    // if teamsCount changed, resize
    if (store.chats[key].teamsCount !== teamsCount) {
      store.chats[key].teamsCount = teamsCount;
      store.chats[key].teams = Array.from({ length: teamsCount }, () => []);
      store.chats[key].substitutes = [];
      store.chats[key].registered = {};
      saveDataSync(store);
    }
  }
  return store.chats[key];
}

function findEligibleTeamsForKeeper(state) {
  const res = [];
  for (let i = 0; i < state.teamsCount; i++) {
    const team = state.teams[i] || [];
    const hasKeeper = team.some(p => p.role === 'keeper');
    if (!hasKeeper) res.push(i);
  }
  return res;
}
function teamSize(team) { return team.length; }
function findEligibleTeamsForPlayer(state) {
  const res = [];
  for (let i = 0; i < state.teamsCount; i++) {
    if (teamSize(state.teams[i]) < 5) res.push(i);
  }
  return res;
}

function assignRandom(state, entry) {
  // entry: {id,name,role}
  if (entry.role === 'keeper') {
    const elig = findEligibleTeamsForKeeper(state);
    if (elig.length === 0) {
      // no keeper slots -> return no assign
      return { assigned: false, reason: 'noKeeperSlot' };
    }
    shuffle(elig);
    const pick = elig[0];
    state.teams[pick].push({...entry, teamIndex: pick});
    state.registered[entry.id] = {...entry, teamIndex: pick};
    state.lastUpdated = Date.now();
    saveDataSync(store);
    return { assigned: true, teamIndex: pick };
  } else {
    const elig = findEligibleTeamsForPlayer(state);
    if (elig.length === 0) {
      // substitutes
      state.substitutes.push({...entry, teamIndex: -1});
      state.registered[entry.id] = {...entry, teamIndex: -1};
      state.lastUpdated = Date.now();
      saveDataSync(store);
      return { assigned: true, substitute: true };
    } else {
      shuffle(elig);
      const pick = elig[0];
      state.teams[pick].push({...entry, teamIndex: pick});
      state.registered[entry.id] = {...entry, teamIndex: pick};
      state.lastUpdated = Date.now();
      saveDataSync(store);
      return { assigned: true, teamIndex: pick };
    }
  }
}

function reshuffle(state) {
  // gather keepers and players
  const keepers = [];
  const players = [];
  for (const uid in state.registered) {
    const r = state.registered[uid];
    if (r.role === 'keeper') keepers.push({id: r.id, name: r.name, role: 'keeper'});
    else players.push({id: r.id, name: r.name, role: 'player'});
  }
  // reset
  state.teams = Array.from({ length: state.teamsCount }, () => []);
  state.substitutes = [];
  state.registered = {};
  // assign keepers up to teamsCount
  shuffle(keepers);
  for (let i = 0; i < keepers.length; i++) {
    if (i < state.teamsCount) {
      state.teams[i].push({...keepers[i], role:'keeper', teamIndex: i});
      state.registered[keepers[i].id] = {...keepers[i], role:'keeper', teamIndex: i};
    } else {
      players.push({id: keepers[i].id, name: keepers[i].name, role:'player'});
    }
  }
  shuffle(players);
  for (const p of players) {
    const elig = findEligibleTeamsForPlayer(state);
    if (elig.length === 0) {
      state.substitutes.push({...p, teamIndex: -1});
      state.registered[p.id] = {...p, teamIndex: -1, role:'player'};
    } else {
      shuffle(elig);
      const pick = elig[0];
      state.teams[pick].push({...p, role:'player', teamIndex: pick});
      state.registered[p.id] = {...p, role:'player', teamIndex: pick};
    }
  }
  state.lastUpdated = Date.now();
  saveDataSync(store);
}

// format message
function formatTeamsMessage(state) {
  const lines = [];
  lines.push('🏆 وضعیت تیم‌ها (لایو)');
  lines.push('');
  const emojis = ['🔵 تیم 1','🟢 تیم 2','🟡 تیم 3','🟠 تیم 4'];
  for (let i=0;i<state.teamsCount;i++){
    const team = state.teams[i]||[];
    lines.push(`${emojis[i]} — ${team.length} بازیکن`);
    const keeper = team.find(x=>x.role==='keeper');
    if (keeper) lines.push(`  🧤 ${keeper.name}`);
    const players = team.filter(x=>x.role==='player');
    for (const p of players) lines.push(`  ⚽ ${p.name}`);
    if (team.length===0) lines.push('  —');
    lines.push('');
  }
  if (state.substitutes && state.substitutes.length){
    lines.push('🔄 تعویضی‌ها:');
    for (const s of state.substitutes) lines.push(`  🔁 ${s.name}`);
  } else {
    lines.push('🔄 تعویضی‌ها: —');
  }
  lines.push('');
  lines.push('📌 هر کس فقط یک بار می‌تواند ثبت‌نام کند.');
  lines.push('👑 فقط ادمین می‌تواند «🔄 قاطی‌کردن دوباره» را بزند.');
  return lines.join('\n');
}

// ---------- Bot handlers (similar flow as before but robust) ----------

// /start (private or group hint)
bot.start(async (ctx) => {
  try {
    if (ctx.chat.type === 'private') {
      await ctx.reply('🤖 ربات «تیم‌چین» — خوش آمدی!\nمی‌خوای داخل بات (سریع) تیم بچینی یا داخل گروه؟',
        Markup.inlineKeyboard([[Markup.button.callback('👤 داخل ربات', 'pv_inside')],[Markup.button.callback('👥 داخل گروه', 'pv_group')]]));
    } else {
      await ctx.reply('برای شروع تیم‌چینی ادمین گروه با دستور /start_team اقدام کند.');
    }
  } catch (e){ console.error('start err', e); }
});

bot.command('start_team', async (ctx) => {
  try {
    if (!['group','supergroup'].includes(ctx.chat.type)) {
      return ctx.reply('این دستور فقط داخل گروه کار می‌کند. در چت خصوصی /start را بزن.');
    }
    const member = await ctx.getChatMember(ctx.from.id);
    if (!['administrator','creator'].includes(member.status)) {
      return ctx.reply('❌ فقط ادمین گروه می‌تواند تیم‌چینی را شروع کند.');
    }
    await ctx.reply('چند تیم می‌خواهی؟ 🧮', Markup.inlineKeyboard([
      [Markup.button.callback('2️⃣ ۲ تیم','choose:2')],
      [Markup.button.callback('3️⃣ ۳ تیم','choose:3')],
      [Markup.button.callback('4️⃣ ۴ تیم','choose:4')]
    ]));
  } catch (e){ console.error(e); }
});

bot.action('pv_inside', async (ctx)=> {
  try {
    if (ctx.chat.type !== 'private') return ctx.answerCbQuery();
    await ctx.editMessageText('🔢 داخل ربات — چند تیم می‌خوای؟',
      Markup.inlineKeyboard([[Markup.button.callback('2️⃣ ۲ تیم','pv_choose:2'), Markup.button.callback('3️⃣ ۳ تیم','pv_choose:3')],[Markup.button.callback('4️⃣ ۴ تیم','pv_choose:4')]]));
  } catch (e){ console.error(e); }
});

bot.action('pv_group', async (ctx)=> {
  try {
    if (ctx.chat.type !== 'private') return ctx.answerCbQuery();
    const botName = ctx.botInfo.username || 'bot';
    await ctx.editMessageText(`برای استفاده داخل گروه:\n1) ربات را به گروه اضافه کن.\n2) ادمین در گروه دستور /start_team را اجرا کند.\nدر صورت نیاز نام ربات: @${botName}`);
  } catch (e){ console.error(e); }
});

// private choose
bot.action(/pv_choose:(\d+)/, async (ctx) => {
  try {
    const cnt = Number(ctx.match[1]);
    if (ctx.chat.type !== 'private') return ctx.answerCbQuery();
    // set a small flow marker
    ensureChatState(ctx.from.id, cnt); // using user id as key for private temp state (not saved among chats though)
    // we'll store awaiting names in a simple userFlows in-memory object
    userFlows[ctx.from.id] = { teamsCount: cnt, step: 'await_names' };
    await ctx.editMessageText('✍️ لطفاً نام بازیکن‌ها را با فاصله ارسال کنید (مثال: Ali Reza Sara Mina).');
  } catch (e){ console.error(e); }
});

// group choose
bot.action(/choose:(\d+)/, async (ctx) => {
  try {
    if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.answerCbQuery();
    const member = await ctx.getChatMember(ctx.from.id);
    if (!['administrator','creator'].includes(member.status)) {
      return ctx.answerCbQuery('فقط ادمین می‌تواند تعداد تیم را انتخاب کند.');
    }
    const cnt = Number(ctx.match[1]);
    const chatId = ctx.chat.id;
    await acquire(chatId);
    try {
      const state = ensureChatState(chatId, cnt);
      // set admin
      if (!state.adminIds.includes(String(ctx.from.id))) state.adminIds.push(String(ctx.from.id));
      // reset teams/registered
      state.teamsCount = cnt;
      state.teams = Array.from({ length: cnt }, () => []);
      state.substitutes = [];
      state.registered = {};
      state.lastUpdated = Date.now();
      saveDataSync(store);

      // send initial interactive message and store message_id
      const sent = await ctx.reply('🏆 تیم‌چینی شروع شد!\nنقش خودتو انتخاب کن 👇',
        Markup.inlineKeyboard([
          [Markup.button.callback('⚽ بازیکن', 'role:player'), Markup.button.callback('🧤 دروازه‌بان', 'role:keeper')],
          [Markup.button.callback('🔄 قاطی‌کردن دوباره (ادمین)', 'reshuffle')]
        ]));
      state.message_id = sent.message_id;
      saveDataSync(store);

      // immediately edit to show empty teams (best-effort)
      const txt = formatTeamsMessage(state);
      try { await ctx.telegram.editMessageText(chatId, state.message_id, null, txt, { parse_mode: 'HTML', ...Markup.inlineKeyboard([
        [Markup.button.callback('⚽ بازیکن', 'role:player'), Markup.button.callback('🧤 دروازه‌بان', 'role:keeper')],
        [Markup.button.callback('🔄 قاطی‌کردن دوباره (ادمین)', 'reshuffle')]
      ]) }); } catch(e){}
    } finally { release(chatId); }
    await ctx.answerCbQuery();
  } catch (e){ console.error(e); }
});

// in-memory flows for private name list
const userFlows = {}; // userId -> {teamsCount, step}

// handle private texts (names)
bot.on('text', async (ctx) => {
  try {
    if (ctx.chat.type === 'private') {
      const flow = userFlows[ctx.from.id];
      if (flow && flow.step === 'await_names') {
        const raw = ctx.message.text.trim();
        if (!raw) return ctx.reply('لطفاً حداقل یک نام وارد کن.');
        const names = raw.split(/\s+/).filter(Boolean);
        if (names.length === 0) return ctx.reply('لطفاً حداقل یک نام وارد کن.');

        // create temp state
        const temp = { teamsCount: flow.teamsCount, teams: Array.from({ length: flow.teamsCount }, () => []), substitutes: [], registered: {} };
        const entries = names.map((n,i) => ({ id:`pv_${ctx.from.id}_${i}`, name: n, role:'player' }));
        shuffle(entries);
        for (const e of entries) assignRandom(temp, e);

        // prepare result
        const out = ['🎲 نتیجهٔ تیم‌ها:',''];
        for (let i=0;i<temp.teamsCount;i++){
          out.push(`🏅 تیم ${i+1}:`);
          const t = temp.teams[i];
          if (!t || t.length===0) out.push('  —');
          else {
            for (const m of t) out.push(`  ⚽ ${m.name}`);
          }
          out.push('');
        }
        if (temp.substitutes.length) {
          out.push('🔄 تعویضی‌ها:');
          for (const s of temp.substitutes) out.push(`  🔁 ${s.name}`);
        }
        delete userFlows[ctx.from.id];
        return ctx.reply(out.join('\n'));
      }
    }
  } catch (e){ console.error('text handler err', e); }
});

// handle role clicks in group
bot.action('role:player', async (ctx) => {
  try {
    if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.answerCbQuery('این دکمه فقط در گروه کار می‌کند.');
    const chatId = ctx.chat.id;
    await acquire(chatId);
    try {
      const state = store.chats[String(chatId)];
      if (!state) return ctx.answerCbQuery('هیچ مسابقه‌ای فعال نیست.');
      const uid = String(ctx.from.id);
      if (state.registered[uid]) return ctx.answerCbQuery('شما قبلاً ثبت‌نام کرده‌اید.');
      const entry = { id: uid, name: displayName(ctx.from), role: 'player' };
      const res = assignRandom(state, entry);
      await ctx.answerCbQuery(res.substitute ? 'تیم‌ها پر هستند — شما به عنوان تعویضی ثبت شدید.' : 'شما به تیم اضافه شدید.');
      // edit team message
      if (state.message_id) {
        const txt = formatTeamsMessage(state);
        try { await ctx.telegram.editMessageText(chatId, state.message_id, null, txt, Markup.inlineKeyboard([
          [Markup.button.callback('⚽ بازیکن', 'role:player'), Markup.button.callback('🧤 دروازه‌بان', 'role:keeper')],
          [Markup.button.callback('🔄 قاطی‌کردن دوباره (ادمین)', 'reshuffle')]
        ])); } catch(e){}
      }
    } finally { release(chatId); }
  } catch (e){ console.error('player action err', e); }
});

bot.action('role:keeper', async (ctx) => {
  try {
    if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.answerCbQuery('این دکمه فقط در گروه کار می‌کند.');
    const chatId = ctx.chat.id;
    await acquire(chatId);
    try {
      const state = store.chats[String(chatId)];
      if (!state) return ctx.answerCbQuery('هیچ مسابقه‌ای فعال نیست.');
      const uid = String(ctx.from.id);
      if (state.registered[uid]) return ctx.answerCbQuery('شما قبلاً ثبت‌نام کرده‌اید.');
      const elig = findEligibleTeamsForKeeper(state);
      if (elig.length === 0) return ctx.answerCbQuery('همهٔ تیم‌ها دروازه‌بان دارند.');
      const entry = { id: uid, name: displayName(ctx.from), role: 'keeper' };
      const res = assignRandom(state, entry);
      await ctx.answerCbQuery('🧤 شما به عنوان دروازه‌بان ثبت شدید.');
      if (state.message_id) {
        const txt = formatTeamsMessage(state);
        try { await ctx.telegram.editMessageText(chatId, state.message_id, null, txt, Markup.inlineKeyboard([
          [Markup.button.callback('⚽ بازیکن', 'role:player'), Markup.button.callback('🧤 دروازه‌بان', 'role:keeper')],
          [Markup.button.callback('🔄 قاطی‌کردن دوباره (ادمین)', 'reshuffle')]
        ])); } catch(e){}
      }
    } finally { release(chatId); }
  } catch (e){ console.error('keeper action err', e); }
});

bot.action('reshuffle', async (ctx) => {
  try {
    if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.answerCbQuery();
    const member = await ctx.getChatMember(ctx.from.id);
    if (!['administrator','creator'].includes(member.status)) return ctx.answerCbQuery('فقط ادمین می‌تواند این را بزند.');
    const chatId = ctx.chat.id;
    await acquire(chatId);
    try {
      const state = store.chats[String(chatId)];
      if (!state) return ctx.answerCbQuery('هیچ مسابقه‌ای فعال نیست.');
      reshuffle(state);
      if (state.message_id) {
        const txt = formatTeamsMessage(state);
        try { await ctx.telegram.editMessageText(chatId, state.message_id, null, txt, Markup.inlineKeyboard([
          [Markup.button.callback('⚽ بازیکن', 'role:player'), Markup.button.callback('🧤 دروازه‌بان', 'role:keeper')],
          [Markup.button.callback('🔄 قاطی‌کردن دوباره (ادمین)', 'reshuffle')]
        ])); } catch(e){}
      }
      await ctx.answerCbQuery('🔀 تیم‌ها دوباره شانسی چیده شدند.');
    } finally { release(chatId); }
  } catch (e){ console.error('reshuffle err', e); }
});

// ---------- safe launch: delete webhook then polling ----------
async function startBot() {
  try {
    // try delete webhook
    try {
      await bot.telegram.deleteWebhook();
      console.log('Deleted webhook if any.');
    } catch (e) {
      console.warn('Webhook delete warning', e && e.description ? e.description : e.message || e);
    }

    await bot.launch({ dropPendingUpdates: true });
    console.log('Bot started (polling).');
  } catch (e) {
    console.error('Bot launch failed:', e);
    process.exit(1);
  }
}
startBot();

// ========== express health endpoint (for Render) ==========
const app = express();
app.get('/healthz', (req, res) => res.send({ ok: true, time: new Date().toISOString() }));
app.get('/', (req, res) => res.send('Team-random-bot alive'));
app.listen(PORT, () => console.log('HTTP server running on port', PORT));

// graceful shutdown
process.once('SIGINT', () => { console.log('SIGINT'); bot.stop('SIGINT'); process.exit(0); });
process.once('SIGTERM', () => { console.log('SIGTERM'); bot.stop('SIGTERM'); process.exit(0); });
