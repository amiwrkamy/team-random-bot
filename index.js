// index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const crypto = require('crypto');
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ لطفاً BOT_TOKEN را در متغیرهای محیطی تنظیم کنید.');
  process.exit(1);
}

const DATA_FILE = path.join(process.cwd(), 'data.json');
const BACKUP_DIR = path.join(process.cwd(), 'backups');
const PORT = process.env.PORT || 3000;
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ---------- persistence helpers ----------
function safeWrite(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function loadData() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      const base = { chats: {}, meta: { createdAt: Date.now() } };
      safeWrite(DATA_FILE, base);
      return base;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('loadData error, recreating data file', e);
    const base = { chats: {}, meta: { createdAt: Date.now() } };
    safeWrite(DATA_FILE, base);
    return base;
  }
}
function saveAll(data) {
  try {
    safeWrite(DATA_FILE, data);
  } catch (e) {
    console.error('saveAll error', e);
  }
}

// periodic backup every 5 minutes
cron.schedule('*/5 * * * *', () => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const dest = path.join(BACKUP_DIR, `data-backup-${stamp}.json`);
    fs.copyFileSync(DATA_FILE, dest);
    console.log('Backup created:', dest);
  } catch (e) {
    console.error('Backup failed', e);
  }
});

// ---------- crypto-based utilities ----------
function secureRandomInt(max) {
  // returns integer in [0, max)
  if (max <= 0) return 0;
  return crypto.randomInt(max);
}
function secureShuffle(arr) {
  // Fisher-Yates using crypto.randomInt
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function secureChoice(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[crypto.randomInt(arr.length)];
}

// ---------- helpers ----------
function displayName(user) {
  if (!user) return '—';
  if (user.username) return '@' + user.username;
  const parts = [user.first_name, user.last_name].filter(Boolean);
  return parts.join(' ') || `${user.id}`;
}

// locks to avoid race conditions
const locks = new Map();
async function acquire(chatId) {
  while (locks.get(chatId)) await new Promise(r => setTimeout(r, 20));
  locks.set(chatId, true);
}
function release(chatId) { locks.delete(chatId); }

// ---------- store ----------
const store = loadData(); // { chats: { chatId: {...} } }

// ---------- core logic with balanced assignment ----------

function ensureChat(chatId, teamsCount = 2) {
  const key = String(chatId);
  if (!store.chats[key]) {
    store.chats[key] = {
      chatId: key,
      teamsCount,
      teams: Array.from({ length: teamsCount }, () => []),
      substitutes: [],
      registered: {}, // userId -> {id,name,role,teamIndex}
      message_id: null,
      adminIds: [],
      lastUpdated: Date.now()
    };
    saveAll(store);
  } else {
    if (store.chats[key].teamsCount !== teamsCount) {
      store.chats[key].teamsCount = teamsCount;
      store.chats[key].teams = Array.from({ length: teamsCount }, () => []);
      store.chats[key].substitutes = [];
      store.chats[key].registered = {};
      store.chats[key].lastUpdated = Date.now();
      saveAll(store);
    }
  }
  return store.chats[key];
}

// return sizes (count of non-sub entries) for each team
function teamEffectiveSize(team) {
  // team entries have role: 'keeper'|'player'|'sub'
  return team.filter(x => x.role !== 'sub').length;
}

// find teams without keeper
function keeperSlots(state) {
  const res = [];
  for (let i = 0; i < state.teamsCount; i++) {
    const hasKeeper = state.teams[i].some(p => p.role === 'keeper');
    if (!hasKeeper) res.push(i);
  }
  return res;
}

// Balanced selection for keeper: among teams without keeper choose one(s) with minimal effective size
function chooseBalancedKeeperTeam(state) {
  const slots = keeperSlots(state);
  if (!slots.length) return null;
  // compute sizes
  let minSize = Infinity;
  const best = [];
  for (const idx of slots) {
    const sz = teamEffectiveSize(state.teams[idx]);
    if (sz < minSize) {
      minSize = sz;
      best.length = 0;
      best.push(idx);
    } else if (sz === minSize) {
      best.push(idx);
    }
  }
  return secureChoice(best);
}

// Balanced selection for player: prefer teams with smallest effective size (<5)
function chooseBalancedPlayerTeam(state) {
  // collect teams with size < 5
  let minSize = Infinity;
  for (let i = 0; i < state.teamsCount; i++) {
    const s = teamEffectiveSize(state.teams[i]);
    if (s < minSize) minSize = s;
  }
  // prefer teams with size == minSize and s < 5
  const candidates = [];
  for (let i = 0; i < state.teamsCount; i++) {
    const s = teamEffectiveSize(state.teams[i]);
    if (s === minSize && s < 5) candidates.push(i);
  }
  if (candidates.length > 0) return secureChoice(candidates);
  // else, if no team has space (<5), return null for substitute
  return null;
}

// assign entry (balanced + secure randomness)
function assignEntry(state, entry) {
  // entry: { id, name, role: 'keeper'|'player' }
  if (entry.role === 'keeper') {
    const choice = chooseBalancedKeeperTeam(state);
    if (choice === null || choice === undefined) {
      return { ok: false, reason: 'no_keeper_slot' };
    }
    state.teams[choice].push({ ...entry, role: 'keeper', teamIndex: choice });
    state.registered[entry.id] = { ...entry, role: 'keeper', teamIndex: choice };
    state.lastUpdated = Date.now();
    saveAll(store);
    return { ok: true, teamIndex: choice };
  } else {
    const choice = chooseBalancedPlayerTeam(state);
    if (choice === null) {
      // no team has space -> substitute
      state.substitutes.push({ ...entry, role: 'sub', teamIndex: -1 });
      state.registered[entry.id] = { ...entry, role: 'sub', teamIndex: -1 };
      state.lastUpdated = Date.now();
      saveAll(store);
      return { ok: true, substitute: true };
    } else {
      state.teams[choice].push({ ...entry, role: 'player', teamIndex: choice });
      state.registered[entry.id] = { ...entry, role: 'player', teamIndex: choice };
      state.lastUpdated = Date.now();
      saveAll(store);
      return { ok: true, teamIndex: choice };
    }
  }
}

// reshuffle balanced: reassign keepers first then players to keep balance
function reshuffleAll(state) {
  const keepers = [];
  const players = [];
  for (const uid in state.registered) {
    const r = state.registered[uid];
    if (r.role === 'keeper') keepers.push({ id: r.id, name: r.name, role: 'keeper' });
    else if (r.role === 'player' || r.role === 'sub') players.push({ id: r.id, name: r.name, role: 'player' });
  }

  // reset
  state.teams = Array.from({ length: state.teamsCount }, () => []);
  state.substitutes = [];
  state.registered = {};

  // shuffle keepers securely and assign each to team with smallest size (initially 0)
  secureShuffle(keepers);
  for (let i = 0; i < keepers.length; i++) {
    if (i < state.teamsCount) {
      state.teams[i].push({ ...keepers[i], role: 'keeper', teamIndex: i });
      state.registered[keepers[i].id] = { ...keepers[i], role: 'keeper', teamIndex: i };
    } else {
      // extra keepers become players
      players.push({ id: keepers[i].id, name: keepers[i].name, role: 'player' });
    }
  }

  // shuffle players securely and assign one-by-one to the team with smallest effective size (<5)
  secureShuffle(players);
  for (const p of players) {
    // find teams with minimal size (<5)
    let minSize = Infinity;
    for (let i = 0; i < state.teamsCount; i++) {
      const s = teamEffectiveSize(state.teams[i]);
      if (s < minSize) minSize = s;
    }
    const candidates = [];
    for (let i = 0; i < state.teamsCount; i++) {
      const s = teamEffectiveSize(state.teams[i]);
      if (s === minSize && s < 5) candidates.push(i);
    }
    if (candidates.length === 0) {
      // all full -> substitute
      state.substitutes.push({ ...p, role: 'sub', teamIndex: -1 });
      state.registered[p.id] = { ...p, role: 'sub', teamIndex: -1 };
    } else {
      const pick = secureChoice(candidates);
      state.teams[pick].push({ ...p, role: 'player', teamIndex: pick });
      state.registered[p.id] = { ...p, role: 'player', teamIndex: pick };
    }
  }

  state.lastUpdated = Date.now();
  saveAll(store);
}

// ---------- formatting + keyboard ----------
function formatTeams(state) {
  const lines = [];
  lines.push('🏆 وضعیت تیم‌ها (لایو)');
  lines.push('');
  const emojis = ['🔵 تیم 1','🟢 تیم 2','🟡 تیم 3','🟠 تیم 4'];
  for (let i = 0; i < state.teamsCount; i++) {
    lines.push(`${emojis[i]} — ${state.teams[i].length} نفر`);
    const keeper = state.teams[i].find(x => x.role === 'keeper');
    if (keeper) lines.push(`  🧤 ${keeper.name}`);
    const players = state.teams[i].filter(x => x.role === 'player');
    if (players.length) {
      for (const p of players) lines.push(`  ⚽ ${p.name}`);
    } else {
      if (!keeper) lines.push('  —');
    }
    lines.push('');
  }
  if (state.substitutes.length) {
    lines.push('🔄 تعویضی‌ها:');
    state.substitutes.forEach(s => lines.push(`  🔁 ${s.name}`));
  } else {
    lines.push('🔄 تعویضی‌ها: —');
  }
  lines.push('');
  lines.push('📌 هر نفر فقط یک‌بار می‌تواند ثبت‌نام کند.');
  lines.push('👑 فقط ادمین می‌تواند «🔀 قاطی‌کردن دوباره» را اجرا کند.');
  return lines.join('\n');
}

function buildKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '⚽ ثبت بازیکن', callback_data: 'role:player' },
        { text: '🧤 ثبت دروازه‌بان', callback_data: 'role:keeper' }
      ],
      [
        { text: '🔀 قاطی‌کردن دوباره (ادمین)', callback_data: 'reshuffle' }
      ]
    ]
  };
}

// ---------- bot setup ----------
const bot = new Telegraf(BOT_TOKEN);

// attempt to remove webhook (avoid 409)
(async () => {
  try {
    await bot.telegram.deleteWebhook();
    console.log('Webhook deleted (if existed).');
  } catch (e) {
    console.warn('deleteWebhook warning', e && e.description ? e.description : e.message || e);
  }
})();

// ---------- handlers (private & group flows) ----------
const privateFlows = {}; // userId -> { teamsCount, waitingNames }

bot.start(async (ctx) => {
  try {
    if (ctx.chat.type === 'private') {
      await ctx.reply('🤖 ربات «تیم‌چین» — خوش آمدی!\nمی‌خوای داخل ربات تیم‌بندی کنی یا داخل گروه؟',
        Markup.inlineKeyboard([
          [Markup.button.callback('👤 داخل ربات', 'pv_inside')],
          [Markup.button.callback('👥 داخل گروه', 'pv_group')]
        ]));
    } else {
      await ctx.reply('در گروه: ادمین دستور /start_team را اجرا کند.');
    }
  } catch (e) { console.error('start error', e); }
});

bot.command('start_team', async (ctx) => {
  try {
    if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.reply('این دستور فقط داخل گروه کار می‌کند.');
    const member = await ctx.getChatMember(ctx.from.id);
    if (!['administrator','creator'].includes(member.status)) return ctx.reply('فقط ادمین می‌تواند تیم‌چینی را شروع کند.');
    await ctx.reply('چند تیم می‌خواهی؟ 🧮', Markup.inlineKeyboard([
      [Markup.button.callback('2️⃣ ۲ تیم', 'choose:2')],
      [Markup.button.callback('3️⃣ ۳ تیم', 'choose:3')],
      [Markup.button.callback('4️⃣ ۴ تیم', 'choose:4')]
    ]));
  } catch (e) { console.error('start_team', e); }
});

// private handlers
bot.action('pv_inside', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.answerCbQuery();
  await ctx.editMessageText('🔢 داخل ربات — چند تیم می‌خوای؟',
    Markup.inlineKeyboard([[Markup.button.callback('2️⃣ ۲ تیم','pv_choose:2'), Markup.button.callback('3️⃣ ۳ تیم','pv_choose:3')],[Markup.button.callback('4️⃣ ۴ تیم','pv_choose:4')]]));
});
bot.action('pv_group', async (ctx) => {
  if (ctx.chat.type !== 'private') return ctx.answerCbQuery();
  const botName = ctx.botInfo.username || 'bot';
  await ctx.editMessageText(`برای استفاده داخل گروه:\n1) ربات را به گروه اضافه کن\n2) ادمین /start_team را اجرا کند\nنام ربات: @${botName}`);
});
bot.action(/pv_choose:(\d+)/, async (ctx) => {
  const cnt = Number(ctx.match[1]);
  if (ctx.chat.type !== 'private') return ctx.answerCbQuery();
  privateFlows[ctx.from.id] = { teamsCount: cnt, waitingNames: true };
  await ctx.editMessageText('✍️ اسم‌ها را با فاصله ارسال کن (مثال: Ali Reza Sara). بعد از ارسال، ربات آن‌ها را شانسی و متعادل تقسیم می‌کند.');
});

// private text handler (names)
bot.on('message', async (ctx, next) => {
  try {
    if (ctx.chat.type === 'private' && ctx.message && ctx.message.text) {
      const flow = privateFlows[ctx.from.id];
      if (flow && flow.waitingNames) {
        const raw = ctx.message.text.trim();
        if (!raw) return ctx.reply('لطفاً حداقل یک نام وارد کنید.');
        const names = raw.split(/\s+/).filter(Boolean);
        if (!names.length) return ctx.reply('لطفاً حداقل یک نام وارد کنید.');
        const entries = names.map((n, i) => ({ id: `pv_${ctx.from.id}_${i}_${Date.now()}`, name: n, role: 'player' }));
        secureShuffle(entries);
        // temp balanced assignment
        const tempState = { teamsCount: flow.teamsCount, teams: Array.from({ length: flow.teamsCount }, () => []), substitutes: [], registered: {} };
        for (const e of entries) {
          // pick team with min effective size (<5)
          let minSize = Infinity;
          for (let i = 0; i < tempState.teamsCount; i++) {
            const s = teamEffectiveSize(tempState.teams[i]);
            if (s < minSize) minSize = s;
          }
          const candidates = [];
          for (let i = 0; i < tempState.teamsCount; i++) {
            const s = teamEffectiveSize(tempState.teams[i]);
            if (s === minSize && s < 5) candidates.push(i);
          }
          if (candidates.length === 0) {
            tempState.substitutes.push({ ...e, role: 'sub', teamIndex: -1 });
            tempState.registered[e.id] = { ...e, role: 'sub', teamIndex: -1 };
          } else {
            const pick = secureChoice(candidates);
            tempState.teams[pick].push({ ...e, role: 'player', teamIndex: pick });
            tempState.registered[e.id] = { ...e, role: 'player', teamIndex: pick };
          }
        }
        // format result
        const out = ['🎲 نتیجهٔ تیم‌ها:',''];
        const emojis = ['🔵 تیم 1','🟢 تیم 2','🟡 تیم 3','🟠 تیم 4'];
        for (let i = 0; i < tempState.teamsCount; i++) {
          out.push(`${emojis[i]}:`);
          const t = tempState.teams[i];
          if (!t.length) out.push('  —');
          else t.forEach(m => out.push(`  ⚽ ${m.name}`));
          out.push('');
        }
        if (tempState.substitutes.length) {
          out.push('🔄 تعویضی‌ها:');
          tempState.substitutes.forEach(s => out.push(`  🔁 ${s.name}`));
        }
        delete privateFlows[ctx.from.id];
        return ctx.reply(out.join('\n'));
      }
    }
  } catch (e) { console.error('private names', e); }
  return next();
});

// group: choose team count
bot.action(/choose:(\d+)/, async (ctx) => {
  try {
    if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.answerCbQuery();
    const member = await ctx.getChatMember(ctx.from.id);
    if (!['administrator','creator'].includes(member.status)) return ctx.answerCbQuery('فقط ادمین می‌تواند تعداد تیم را انتخاب کند.');
    const cnt = Number(ctx.match[1]);
    const chatId = ctx.chat.id;
    await acquire(chatId);
    try {
      const state = ensureChat(chatId, cnt);
      state.teamsCount = cnt;
      state.teams = Array.from({ length: cnt }, () => []);
      state.substitutes = [];
      state.registered = {};
      if (!state.adminIds.includes(String(ctx.from.id))) state.adminIds.push(String(ctx.from.id));
      state.lastUpdated = Date.now();
      saveAll(store);

      const sent = await ctx.reply('🏆 تیم‌چینی شروع شد!\nنقش خودتو انتخاب کن 👇', { reply_markup: buildKeyboard() });
      state.message_id = sent.message_id;
      saveAll(store);

      try {
        await ctx.telegram.editMessageText(chatId, state.message_id, null, formatTeams(state), { reply_markup: buildKeyboard() });
      } catch(e){}
    } finally { release(chatId); }
    await ctx.answerCbQuery();
  } catch (e) { console.error('choose action', e); }
});

// group role callbacks
bot.action('role:player', async (ctx) => {
  try {
    if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.answerCbQuery('این دکمه فقط در گروه کار می‌کند.');
    const chatId = ctx.chat.id;
    await acquire(chatId);
    try {
      const state = store.chats[String(chatId)];
      if (!state) return ctx.answerCbQuery('هنوز مسابقه‌ای فعال نیست.');
      const uid = String(ctx.from.id);
      if (state.registered[uid]) return ctx.answerCbQuery('شما قبلاً ثبت‌نام کرده‌اید.');
      const entry = { id: uid, name: displayName(ctx.from), role: 'player' };
      const res = assignEntry(state, entry);
      if (res.substitute) await ctx.answerCbQuery('تیم‌ها پر هستند — شما به عنوان تعویضی ثبت شدید.');
      else await ctx.answerCbQuery('شما به تیم اضافه شدید ✅');
      if (state.message_id) {
        try { await ctx.telegram.editMessageText(chatId, state.message_id, null, formatTeams(state), { reply_markup: buildKeyboard() }); } catch(e){}
      }
    } finally { release(chatId); }
  } catch (e) { console.error('role:player', e); }
});

bot.action('role:keeper', async (ctx) => {
  try {
    if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.answerCbQuery('این دکمه فقط در گروه کار می‌کند.');
    const chatId = ctx.chat.id;
    await acquire(chatId);
    try {
      const state = store.chats[String(chatId)];
      if (!state) return ctx.answerCbQuery('هنوز مسابقه‌ای فعال نیست.');
      const uid = String(ctx.from.id);
      if (state.registered[uid]) return ctx.answerCbQuery('شما قبلاً ثبت‌نام کرده‌اید.');
      const slot = chooseBalancedKeeperTeam(state);
      if (slot === null) return ctx.answerCbQuery('همهٔ تیم‌ها دروازه‌بان دارند.');
      const entry = { id: uid, name: displayName(ctx.from), role: 'keeper' };
      const res = assignEntry(state, entry);
      if (res.ok) await ctx.answerCbQuery('🧤 شما به عنوان دروازه‌بان ثبت شدید.');
      if (state.message_id) {
        try { await ctx.telegram.editMessageText(chatId, state.message_id, null, formatTeams(state), { reply_markup: buildKeyboard() }); } catch(e){}
      }
    } finally { release(chatId); }
  } catch (e) { console.error('role:keeper', e); }
});

// reshuffle by admin
bot.action('reshuffle', async (ctx) => {
  try {
    if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.answerCbQuery();
    const info = await ctx.getChatMember(ctx.from.id);
    if (!['administrator','creator'].includes(info.status)) return ctx.answerCbQuery('فقط ادمین می‌تواند این کار را انجام دهد.');
    const chatId = ctx.chat.id;
    await acquire(chatId);
    try {
      const state = store.chats[String(chatId)];
      if (!state) return ctx.answerCbQuery('فعالی نیست.');
      reshuffleAll(state);
      if (state.message_id) {
        try { await ctx.telegram.editMessageText(chatId, state.message_id, null, formatTeams(state), { reply_markup: buildKeyboard() }); } catch(e){}
      }
      await ctx.answerCbQuery('🔀 تیم‌ها دوباره شانسی و متعادل چیده شدند.');
    } finally { release(chatId); }
  } catch (e) { console.error('reshuffle', e); }
});

// ---------- launch ----------
(async () => {
  try {
    await bot.launch({ dropPendingUpdates: true });
    console.log('Bot started (polling).');
  } catch (e) {
    console.error('Bot launch failed', e);
    process.exit(1);
  }
})();

// express health
const app = ex
