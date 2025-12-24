// index.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ لطفاً BOT_TOKEN را در متغیرهای محیطی تنظیم کنید.');
  process.exit(1);
}

const DATA_FILE = path.join(process.cwd(), 'data.json'); // persistent state
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

// ---------- utils ----------
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function displayName(user) {
  if (!user) return '—';
  if (user.username) return '@' + user.username;
  const parts = [user.first_name, user.last_name].filter(Boolean);
  return parts.join(' ') || `${user.id}`;
}

// ---------- in-memory lock per chat to avoid concurrent edits ----------
const locks = new Map();
async function acquire(chatId) {
  while (locks.get(chatId)) {
    await new Promise(r => setTimeout(r, 25));
  }
  locks.set(chatId, true);
}
function release(chatId) { locks.delete(chatId); }

// ---------- load store ----------
const store = loadData(); // { chats: { chatId: {...} } }

// ---------- core team operations ----------
function ensureChat(chatId, teamsCount = 2) {
  const key = String(chatId);
  if (!store.chats[key]) {
    store.chats[key] = {
      chatId: key,
      teamsCount,
      teams: Array.from({ length: teamsCount }, () => []), // arrays of members
      substitutes: [],
      registered: {}, // userId -> {id,name,role,teamIndex}
      message_id: null,
      adminIds: [],
      lastUpdated: Date.now()
    };
    saveAll(store);
  } else {
    // if teamsCount changed, reset teams & registrations
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

function findKeeperSlots(state) {
  const res = [];
  for (let i = 0; i < state.teamsCount; i++) {
    const hasKeeper = state.teams[i].some(p => p.role === 'keeper');
    if (!hasKeeper) res.push(i);
  }
  return res;
}
function teamsWithSpace(state) {
  const res = [];
  for (let i = 0; i < state.teamsCount; i++) {
    if (state.teams[i].filter(p => p.role !== 'sub').length < 5) res.push(i);
  }
  return res;
}

// assign one entry randomly and maintain registered + persistence
function assignEntry(state, entry) {
  // entry: { id:string, name:string, role: 'player'|'keeper' }
  if (entry.role === 'keeper') {
    const slots = findKeeperSlots(state);
    if (slots.length === 0) {
      return { ok: false, reason: 'no_keeper_slot' };
    }
    shuffle(slots);
    const pick = slots[0];
    state.teams[pick].push({ ...entry, role: 'keeper', teamIndex: pick });
    state.registered[entry.id] = { ...entry, role: 'keeper', teamIndex: pick };
    state.lastUpdated = Date.now();
    saveAll(store);
    return { ok: true, teamIndex: pick };
  } else {
    const elig = teamsWithSpace(state);
    if (elig.length === 0) {
      // put into substitutes
      state.substitutes.push({ ...entry, role: 'sub', teamIndex: -1 });
      state.registered[entry.id] = { ...entry, role: 'sub', teamIndex: -1 };
      state.lastUpdated = Date.now();
      saveAll(store);
      return { ok: true, substitute: true };
    }
    // choose random eligible team (ensures shuffling + balance)
    shuffle(elig);
    const pick = elig[0];
    state.teams[pick].push({ ...entry, role: 'player', teamIndex: pick });
    state.registered[entry.id] = { ...entry, role: 'player', teamIndex: pick };
    state.lastUpdated = Date.now();
    saveAll(store);
    return { ok: true, teamIndex: pick };
  }
}

// reshuffle all current registered users (only admin)
function reshuffleAll(state) {
  // collect keepers and players (ignore substitutes for now, we'll reassign them after)
  const keepers = [];
  const players = [];
  for (const uid in state.registered) {
    const r = state.registered[uid];
    if (r.role === 'keeper') keepers.push({ id: r.id, name: r.name, role: 'keeper' });
    else players.push({ id: r.id, name: r.name, role: 'player' });
  }
  // reset all
  state.teams = Array.from({ length: state.teamsCount }, () => []);
  state.substitutes = [];
  state.registered = {};
  // randomize keepers and place up to teamsCount
  shuffle(keepers);
  for (let i = 0; i < keepers.length; i++) {
    if (i < state.teamsCount) {
      state.teams[i].push({ ...keepers[i], role: 'keeper', teamIndex: i });
      state.registered[keepers[i].id] = { ...keepers[i], role: 'keeper', teamIndex: i };
    } else {
      // overflow keepers -> becomes players
      players.push({ id: keepers[i].id, name: keepers[i].name, role: 'player' });
    }
  }
  // shuffle players and assign into random teams with capacity <5
  shuffle(players);
  for (const p of players) {
    const elig = teamsWithSpace(state);
    if (elig.length === 0) {
      state.substitutes.push({ ...p, role: 'sub', teamIndex: -1 });
      state.registered[p.id] = { ...p, role: 'sub', teamIndex: -1 };
    } else {
      shuffle(elig);
      const pick = elig[0];
      state.teams[pick].push({ ...p, role: 'player', teamIndex: pick });
      state.registered[p.id] = { ...p, role: 'player', teamIndex: pick };
    }
  }
  state.lastUpdated = Date.now();
  saveAll(store);
}

// pretty format message (Persian, emojis)
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

// ---------- bot setup ----------
const bot = new Telegraf(BOT_TOKEN);

// delete webhook to avoid 409
(async () => {
  try {
    await bot.telegram.deleteWebhook();
    console.log('Webhook deleted (if existed).');
  } catch (e) {
    console.warn('deleteWebhook warning', e && e.description ? e.description : e.message || e);
  }
})();

// private /start: ask where (inside bot / inside group)
bot.start(async (ctx) => {
  try {
    if (ctx.chat.type === 'private') {
      await ctx.reply('🤖 ربات «تیم‌چین» — خوش آمدی!\nمی‌خوای تیم‌چینی داخل ربات انجام بشه یا داخل گروه؟',
        Markup.inlineKeyboard([
          [Markup.button.callback('👤 داخل ربات', 'flow:pv_inside')],
          [Markup.button.callback('👥 داخل گروه', 'flow:pv_group')]
        ]));
    } else {
      await ctx.reply('برای شروع تیم‌چینی ادمین گروه دستور /start_team را اجرا کند.');
    }
  } catch (e) { console.error('start error', e); }
});

// admin command inside group to create live team message
bot.command('start_team', async (ctx) => {
  try {
    if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.reply('این دستور فقط داخل گروه کار می‌کند.');
    const member = await ctx.getChatMember(ctx.from.id);
    if (!['administrator','creator'].includes(member.status)) return ctx.reply('فقط ادمین می‌تواند تیم‌چینی را شروع کند.');
    // ask how many teams
    await ctx.reply('چند تیم می‌خوای؟ 🧮', Markup.inlineKeyboard([
      [Markup.button.callback('2️⃣ ۲ تیم', 'choose:2')],
      [Markup.button.callback('3️⃣ ۳ تیم', 'choose:3')],
      [Markup.button.callback('4️⃣ ۴ تیم', 'choose:4')]
    ]));
  } catch (e) { console.error('start_team', e); }
});

// private flows
const privateFlows = {}; // userId -> { teamsCount, waitingNames }

bot.action('flow:pv_inside', async (ctx) => {
  try {
    if (ctx.chat.type !== 'private') return ctx.answerCbQuery();
    await ctx.editMessageText('🔢 داخل ربات — چند تیم می‌خوای؟',
      Markup.inlineKeyboard([
        [Markup.button.callback('2️⃣ ۲ تیم', 'pv_choose:2'), Markup.button.callback('3️⃣ ۳ تیم', 'pv_choose:3')],
        [Markup.button.callback('4️⃣ ۴ تیم', 'pv_choose:4')]
      ]));
  } catch (e) { console.error(e); }
});

bot.action('flow:pv_group', async (ctx) => {
  try {
    if (ctx.chat.type !== 'private') return ctx.answerCbQuery();
    const botName = ctx.botInfo.username || 'bot';
    await ctx.editMessageText(`برای استفاده داخل گروه:\n1) ربات را به گروه اضافه کن.\n2) ادمین در گروه دستور /start_team را اجرا کند.\n(نام ربات: @${botName})`);
  } catch (e) { console.error(e); }
});

bot.action(/pv_choose:(\d+)/, async (ctx) => {
  try {
    const cnt = Number(ctx.match[1]);
    privateFlows[ctx.from.id] = { teamsCount: cnt, waitingNames: true };
    await ctx.editMessageText('✍️ اسم‌ها را با فاصله ارسال کن (مثال: Ali Reza Sara Mina). پس از ارسال ربات آن‌ها را شانسی تقسیم می‌کند.');
  } catch (e) { console.error(e); }
});

// handle private text names
bot.on('message', async (ctx, next) => {
  try {
    if (ctx.chat.type === 'private' && ctx.message && ctx.message.text) {
      const flow = privateFlows[ctx.from.id];
      if (flow && flow.waitingNames) {
        const raw = ctx.message.text.trim();
        if (!raw) return ctx.reply('لطفاً حداقل یک نام وارد کنید.');
        const names = raw.split(/\s+/).filter(Boolean);
        if (!names.length) return ctx.reply('لطفاً حداقل یک نام وارد کنید.');
        // build entries
        const entries = names.map((n, i) => ({ id: `pv_${ctx.from.id}_${i}_${Date.now()}`, name: n, role: 'player' }));
        shuffle(entries);
        const tempState = { teamsCount: flow.teamsCount, teams: Array.from({ length: flow.teamsCount }, () => []), substitutes: [], registered: {} };
        for (const e of entries) {
          // reuse assignEntry logic but adapted to tempState
          const elig = [];
          for (let i = 0; i < tempState.teamsCount; i++) {
            if (tempState.teams[i].filter(p => p.role !== 'sub').length < 5) elig.push(i);
          }
          if (elig.length === 0) {
            tempState.substitutes.push({ ...e, role: 'sub', teamIndex: -1 });
            tempState.registered[e.id] = { ...e, role: 'sub', teamIndex: -1 };
          } else {
            shuffle(elig);
            const pick = elig[0];
            tempState.teams[pick].push({ ...e, role: 'player', teamIndex: pick });
            tempState.registered[e.id] = { ...e, role: 'player', teamIndex: pick };
          }
        }
        // format output
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

// group choose team count (admin)
bot.action(/choose:(\d+)/, async (ctx) => {
  try {
    if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.answerCbQuery();
    const admin = await ctx.getChatMember(ctx.from.id);
    if (!['administrator','creator'].includes(admin.status)) return ctx.answerCbQuery('فقط ادمین می‌تواند تعداد تیم را انتخاب کند.');
    const cnt = Number(ctx.match[1]);
    const chatId = ctx.chat.id;
    await acquire(chatId);
    try {
      const state = ensureChat(chatId, cnt);
      // reset state for new session
      state.teamsCount = cnt;
      state.teams = Array.from({ length: cnt }, () => []);
      state.substitutes = [];
      state.registered = {};
      if (!state.adminIds.includes(String(ctx.from.id))) state.adminIds.push(String(ctx.from.id));
      state.lastUpdated = Date.now();
      saveAll(store);

      // send interactive live message and save message_id
      const sent = await ctx.reply('🏆 تیم‌چینی شروع شد!\nنقش خودتو انتخاب کن 👇', Markup.inlineKeyboard([
        [Markup.button.callback('⚽ بازیکن', 'role:player'), Markup.button.callback('🧤 دروازه‌بان', 'role:keeper')],
        [Markup.button.callback('🔀 قاطی‌کردن دوباره (ادمین)', 'reshuffle')]
      ]));
      state.message_id = sent.message_id;
      saveAll(store);

      // edit it immediately to show empty teams too
      try {
        await ctx.telegram.editMessageText(chatId, state.message_id, null, formatTeams(state), {
          reply_markup: {
            inline_keyboard: [
              [{ text: '⚽ بازیکن', callback_data: 'role:player' }, { text: '🧤 دروازه‌بان', callback_data: 'role:keeper' }],
              [{ text: '🔀 قاطی‌کردن دوباره (ادمین)', callback_data: 'reshuffle' }]
            ]
          }
        });
      } catch(e){ /* ignore */ }
    } finally { release(chatId); }
    await ctx.answerCbQuery();
  } catch (e) { console.error('choose action', e); }
});

// role callbacks in group
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
      if (res.substitute) {
        await ctx.answerCbQuery('تیم‌ها پر هستند — شما به عنوان تعویضی ثبت شدید.');
      } else {
        await ctx.answerCbQuery('شما به تیم اضافه شدید ✅');
      }
      // update main message
      if (state.message_id) {
        try {
          await ctx.telegram.editMessageText(chatId, state.message_id, null, formatTeams(state), {
            parse_mode: 'HTML'
          });
        } catch(e){}
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
      const avail = findKeeperSlots(state);
      if (avail.length === 0) return ctx.answerCbQuery('همهٔ تیم‌ها دروازه‌بان دارند.');
      const entry = { id: uid, name: displayName(ctx.from), role: 'keeper' };
      const res = assignEntry(state, entry);
      await ctx.answerCbQuery('🧤 شما به عنوان دروازه‌بان ثبت شدید.');
      if (state.message_id) {
        try {
          await ctx.telegram.editMessageText(chatId, state.message_id, null, formatTeams(state));
        } catch(e){}
      }
    } finally { release(chatId); }
  } catch (e) { console.error('role:keeper', e); }
});

// reshuffle (admin only)
bot.action('reshuffle', async (ctx) => {
  try {
    if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.answerCbQuery();
    const info = await ctx.getChatMember(ctx.from.id);
    if (!['administrator','creator'].includes(info.status)) return ctx.answerCbQuery('فقط ادمین می‌تواند این کاررو انجام دهد.');
    const chatId = ctx.chat.id;
    await acquire(chatId);
    try {
      const state = store.chats[String(chatId)];
      if (!state) return ctx.answerCbQuery('فعال نیست.');
      reshuffleAll(state);
      if (state.message_id) {
        try {
          await ctx.telegram.editMessageText(chatId, state.message_id, null, formatTeams(state));
        } catch(e){}
      }
      await ctx.answerCbQuery('🔀 تیم‌ها دوباره شانسی چیده شدند.');
    } finally { release(chatId); }
  } catch (e) { console.error('reshuffle', e); }
});

// ---------- start bot listener (polling) ----------
(async () => {
  try {
    await bot.launch({ dropPendingUpdates: true });
    console.log('Bot started (polling).');
  } catch (e) {
    console.error('Bot launch failed', e);
    process.exit(1);
  }
})();

// express health (render)
const app = express();
app.get('/healthz', (req, res) => res.send({ ok: true, time: new Date().toISOString() }));
app.get('/', (req, res) => res.send('team-random-bot running'));
app.listen(PORT, () => console.log('HTTP server running on port', PORT));

// graceful
process.once('SIGINT', () => { bot.stop('SIGINT'); process.exit(0); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
