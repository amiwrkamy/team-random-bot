// index.js — Team Random Bot (resilient, persistent, balanced & truly random)
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cron = require('node-cron');
const crypto = require('crypto');
const { Telegraf, Markup } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('ERROR: set BOT_TOKEN in env');
  process.exit(1);
}

const DATA_FILE = path.join(process.cwd(), 'data.json');
const BACKUP_DIR = path.join(process.cwd(), 'backups');
const PORT = process.env.PORT || 3000;
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

// ---------------- persistence ----------------
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
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('loadData error, recreating', e);
    const base = { chats: {}, meta: { createdAt: Date.now() } };
    safeWrite(DATA_FILE, base);
    return base;
  }
}
function saveStore(store) {
  try { safeWrite(DATA_FILE, store); }
  catch (e) { console.error('saveStore error', e); }
}
const store = loadData();

// periodic backup every 5 minutes
cron.schedule('*/5 * * * *', () => {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g,'-');
    const dest = path.join(BACKUP_DIR, `data-backup-${stamp}.json`);
    fs.copyFileSync(DATA_FILE, dest);
    console.log('Backup saved:', dest);
  } catch (e) { console.error('backup failed', e); }
});

// ---------------- crypto utils ----------------
function randInt(max) {
  if (max <= 0) return 0;
  return crypto.randomInt(max);
}
function choice(arr) {
  if (!arr || arr.length === 0) return null;
  return arr[randInt(arr.length)];
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------- helpers ----------------
function displayName(user) {
  if (!user) return '—';
  if (user.username) return `@${user.username}`;
  const parts = [user.first_name, user.last_name].filter(Boolean);
  return parts.join(' ') || `${user.id}`;
}
function ensureChatState(chatId, teamsCount = 2) {
  const k = String(chatId);
  if (!store.chats[k]) {
    store.chats[k] = {
      chatId: k,
      teamsCount,
      teams: Array.from({ length: teamsCount }, () => ({ keeper: null, players: [], subs: [] })),
      registered: {}, // uid -> {id,name,role,teamIndex}
      message_id: null,
      adminIds: [],
      lastUpdated: Date.now()
    };
    saveStore(store);
  } else {
    if (store.chats[k].teamsCount !== teamsCount) {
      store.chats[k].teamsCount = teamsCount;
      store.chats[k].teams = Array.from({ length: teamsCount }, () => ({ keeper: null, players: [], subs: [] }));
      store.chats[k].registered = {};
      store.chats[k].lastUpdated = Date.now();
      saveStore(store);
    }
  }
  return store.chats[k];
}

// effective team size (keeper + players)
function effectiveSize(team) {
  return (team.keeper ? 1 : 0) + team.players.length;
}
function keeperSlots(state) {
  const out = [];
  for (let i = 0; i < state.teamsCount; i++) if (!state.teams[i].keeper) out.push(i);
  return out;
}

// choose balanced team for keeper (smallest effective size among keeper-less teams)
function chooseKeeperTeam(state) {
  const slots = keeperSlots(state);
  if (!slots.length) return null;
  let minS = Infinity;
  const cands = [];
  for (const idx of slots) {
    const s = effectiveSize(state.teams[idx]);
    if (s < minS) { minS = s; cands.length = 0; cands.push(idx); }
    else if (s === minS) cands.push(idx);
  }
  return choice(cands);
}

// choose balanced team for player (team with minimal effective size <5)
function choosePlayerTeam(state) {
  let minS = Infinity;
  for (let i = 0; i < state.teamsCount; i++) {
    const s = effectiveSize(state.teams[i]);
    if (s < minS) minS = s;
  }
  const candidates = [];
  for (let i = 0; i < state.teamsCount; i++) {
    const s = effectiveSize(state.teams[i]);
    if (s === minS && s < 5) candidates.push(i);
  }
  if (candidates.length === 0) return null;
  return choice(candidates);
}

// when no team has space -> assign to team with smallest subs length (to distribute subs)
function chooseSubTeam(state) {
  let minSubs = Infinity; const c = [];
  for (let i = 0; i < state.teamsCount; i++) {
    const s = state.teams[i].subs.length;
    if (s < minSubs) { minSubs = s; c.length = 0; c.push(i); }
    else if (s === minSubs) c.push(i);
  }
  return choice(c);
}

function assignEntry(state, entry) {
  // entry: { id, name, role: 'keeper'|'player' }
  if (entry.role === 'keeper') {
    const teamIdx = chooseKeeperTeam(state);
    if (teamIdx === null) return { ok: false, reason: 'no_keeper_slot' };
    state.teams[teamIdx].keeper = entry.name;
    state.registered[entry.id] = { ...entry, teamIndex: teamIdx };
    state.lastUpdated = Date.now();
    saveStore(store);
    return { ok: true, teamIndex: teamIdx };
  } else {
    const t = choosePlayerTeam(state);
    if (t === null) {
      const subIdx = chooseSubTeam(state);
      state.teams[subIdx].subs.push(entry.name);
      state.registered[entry.id] = { ...entry, teamIndex: -1, subTeam: subIdx };
      state.lastUpdated = Date.now();
      saveStore(store);
      return { ok: true, substitute: true, teamIndex: -1, subTeam: subIdx };
    } else {
      state.teams[t].players.push(entry.name);
      state.registered[entry.id] = { ...entry, teamIndex: t };
      state.lastUpdated = Date.now();
      saveStore(store);
      return { ok: true, teamIndex: t };
    }
  }
}

// reshuffle all registered users balanced & random
function reshuffleAll(state) {
  const keepers = []; const players = [];
  for (const uid in state.registered) {
    const r = state.registered[uid];
    if (r.role === 'keeper') keepers.push({ id: r.id, name: r.name });
    else players.push({ id: r.id, name: r.name });
  }
  // reset
  state.teams = Array.from({ length: state.teamsCount }, () => ({ keeper: null, players: [], subs: [] }));
  state.registered = {};
  // shuffle keepers & players
  shuffle(keepers); shuffle(players);
  // assign keepers: each to a distinct team up to number of teams (balanced)
  for (let i = 0; i < keepers.length; i++) {
    if (i < state.teamsCount) {
      state.teams[i].keeper = keepers[i].name;
      state.registered[keepers[i].id] = { ...keepers[i], role: 'keeper', teamIndex: i };
    } else {
      players.push({ id: keepers[i].id, name: keepers[i].name }); // extra keepers become players
    }
  }
  // assign players one-by-one to smallest teams (<5)
  for (const p of players) {
    // find teams with minimal effective size (<5)
    let minS = Infinity;
    for (let i = 0; i < state.teamsCount; i++) {
      const s = effectiveSize(state.teams[i]);
      if (s < minS) minS = s;
    }
    const cands = [];
    for (let i = 0; i < state.teamsCount; i++) {
      const s = effectiveSize(state.teams[i]);
      if (s === minS && s < 5) cands.push(i);
    }
    if (cands.length === 0) {
      // place as substitute in smallest subs
      const sidx = chooseSubTeam(state);
      state.teams[sidx].subs.push(p.name);
      state.registered[p.id] = { ...p, role: 'sub', teamIndex: -1, subTeam: sidx };
    } else {
      const pick = choice(cands);
      state.teams[pick].players.push(p.name);
      state.registered[p.id] = { ...p, role: 'player', teamIndex: pick };
    }
  }
  state.lastUpdated = Date.now();
  saveStore(store);
}

// ---------------- UI functions ----------------
function buildKeyboard() {
  // return reply_markup object
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('⚽ ثبت بازیکن', 'join_player'), Markup.button.callback('🧤 ثبت دروازه‌بان', 'join_keeper')],
    [Markup.button.callback('🔀 قاطی‌کردن دوباره (ادمین)', 'reshuffle')]
  ]);
  return kb.reply_markup;
}

function formatTeamsText(state) {
  const lines = [];
  lines.push('🏆 تیم‌چینی — وضعیت (لایو)');
  lines.push('');
  const names = ['تیم 1','تیم 2','تیم 3','تیم 4'];
  for (let i = 0; i < state.teamsCount; i++) {
    lines.push(`🔹 ${names[i]} — ${effectiveSize(state.teams[i])} نفر`);
    if (state.teams[i].keeper) lines.push(`  🧤 ${state.teams[i].keeper}`);
    state.teams[i].players.forEach(p => lines.push(`  ⚽ ${p}`));
    if (state.teams[i].subs.length) {
      lines.push('  🔄 تعویضی‌ها:');
      state.teams[i].subs.forEach(s => lines.push(`    ▫️ ${s}`));
    }
    lines.push('');
  }
  lines.push('📌 هر نفر فقط یک‌بار ثبت‌نام کند. 👑 reshuffle فقط ادمین.');
  return lines.join('\n');
}

// ---------------- safe edit (keeps keyboard) ----------------
async function safeEditMessage(chatId, messageId, text, reply_markup) {
  const tries = 3;
  for (let i = 0; i < tries; i++) {
    try {
      await bot.telegram.editMessageText(chatId, messageId, null, text, { reply_markup });
      return;
    } catch (e) {
      const desc = (e && e.description) ? e.description : (e && e.message) ? e.message : String(e);
      // if not modified -> ignore
      if (desc.includes('message is not modified') || desc.includes('MESSAGE_ID_INVALID')) return;
      console.warn('editMessageText failed, retrying...', i, desc);
      await new Promise(r => setTimeout(r, 120 + i*100));
    }
  }
  console.error('safeEditMessage: failed after retries');
}

// ---------------- locks to serialize group edits ----------------
const groupLocks = new Map();
async function withGroupLock(chatId, fn) {
  while (groupLocks.get(chatId)) await new Promise(r => setTimeout(r, 20));
  groupLocks.set(chatId, true);
  try { return await fn(); }
  finally { groupLocks.delete(chatId); }
}

// ---------------- bot init ----------------
const bot = new Telegraf(BOT_TOKEN);

// delete webhook to avoid 409
(async () => {
  try { await bot.telegram.deleteWebhook(); console.log('webhook deleted'); }
  catch (e) { /* ignore */ }
})();

// ---------------- Handlers ----------------

// /start in private: ask mode + link for adding to group
bot.start(async ctx => {
  if (ctx.chat.type === 'private') {
    const me = await bot.telegram.getMe();
    await ctx.reply('🤖 ربات تیم‌چینی — کجا می‌خوای تیم‌بندی انجام بشه؟', Markup.inlineKeyboard([
      [Markup.button.callback('👤 داخل ربات', 'pv_mode')],
      [Markup.button.callback('👥 داخل گروه', 'pv_group')]
    ]));
  } else {
    await ctx.reply('در گروه: ادمین دستور /start_team را اجرا کند.');
  }
});

// private callbacks
bot.action('pv_mode', async ctx => {
  if (ctx.chat.type !== 'private') return ctx.answerCbQuery();
  await ctx.editMessageText('🔢 داخل ربات — چند تیم می‌خوای؟', Markup.inlineKeyboard([
    [Markup.button.callback('2️⃣ ۲ تیم','pv_choose:2'), Markup.button.callback('3️⃣ ۳ تیم','pv_choose:3')],
    [Markup.button.callback('4️⃣ ۴ تیم','pv_choose:4')]
  ]));
});

bot.action('pv_group', async ctx => {
  if (ctx.chat.type !== 'private') return ctx.answerCbQuery();
  const me = await bot.telegram.getMe();
  await ctx.editMessageText(`برای استفاده در گروه:\n1) ربات را به گروه اضافه کنید.\n2) ادمین در گروه دستور /start_team را اجرا کند.\n\nلینک افزودن:\nhttps://t.me/${me.username}?startgroup=true`);
});

// private choose teams
const privateFlows = {}; // userId -> {teamsCount, waitingNames, waitingKeepers}

bot.action(/pv_choose:(\d+)/, async ctx => {
  if (ctx.chat.type !== 'private') return ctx.answerCbQuery();
  const n = Number(ctx.match[1]);
  privateFlows[ctx.from.id] = { teamsCount: n, waitingNames: true };
  await ctx.editMessageText('✍️ لطفاً نام‌ها را با فاصله ارسال کنید (مثال: علی رضا سارا). بعد از ارسال، از شما سوال می‌شود آیا دروازه‌بان مشخص داری یا نه.');
});

// private: receive names then ask for keeper names optionally
bot.on('message', async ctx => {
  if (ctx.chat.type !== 'private') {
    return;
  }
  const flow = privateFlows[ctx.from.id];
  if (!flow) return; // no pv flow
  if (flow.waitingNames) {
    const raw = (ctx.message.text || '').trim();
    if (!raw) return ctx.reply('نام معتبر وارد کن.');
    const names = raw.split(/\s+/).filter(Boolean);
    if (!names.length) return ctx.reply('نام معتبر وارد کن.');
    flow.names = names;
    flow.waitingNames = false;
    flow.waitingKeepers = true;
    return ctx.reply('اگر بین این نام‌ها دروازه‌بان مشخص داری، نام/آیدی دروازه‌بان(ها) را با فاصله بفرست. اگر ندارید همینجا بنویس «ندارم» تا ربات خودش شانسی دروازه‌بان انتخاب کند.');
  }
  if (flow.waitingKeepers) {
    const raw = (ctx.message.text || '').trim();
    let keeperNames = [];
    if (raw && !/^ندارم$/i.test(raw)) keeperNames = raw.split(/\s+/).filter(Boolean);
    // build temp state & assign
    const tempState = { teamsCount: flow.teamsCount, teams: Array.from({ length: flow.teamsCount }, () => ({ keeper: null, players: [], subs: [] })), registered: {} };
    // mark keepers if provided (only one GK per team will be enforced by chooseKeeperTeam). If more keepers specified than teams, extras treated as players.
    for (let i = 0; i < keeperNames.length; i++) {
      if (i < tempState.teamsCount) {
        tempState.teams[i].keeper = keeperNames[i];
        tempState.registered[`pv_k_${i}`] = { id: `pv_k_${i}`, name: keeperNames[i], role: 'keeper', teamIndex: i };
      } else {
        // extra become players
        flow.names.push(keeperNames[i]);
      }
    }
    // shuffle remaining names and assign balanced
    const rem = flow.names.filter(n => !keeperNames.includes(n));
    shuffle(rem);
    for (const nm of rem) {
      // use choosePlayerTeam-like on tempState
      // find current minimal effective size (<5)
      let minS = Infinity;
      for (let i = 0; i < tempState.teamsCount; i++) {
        const s = ((tempState.teams[i].keeper ? 1 : 0) + tempState.teams[i].players.length);
        if (s < minS) minS = s;
      }
      const candidates = [];
      for (let i = 0; i < tempState.teamsCount; i++) {
        const s = ((tempState.teams[i].keeper ? 1 : 0) + tempState.teams[i].players.length);
        if (s === minS && s < 5) candidates.push(i);
      }
      if (candidates.length === 0) {
        const subIdx = (() => {
          let minSub = Infinity; const arr = [];
          for (let j=0;j<tempState.teamsCount;j++){
            const sublen = tempState.teams[j].subs.length;
            if (sublen < minSub) { minSub = sublen; arr.length = 0; arr.push(j); }
            else if (sublen === minSub) arr.push(j);
          }
          return choice(arr);
        })();
        tempState.teams[subIdx].subs.push(nm);
      } else {
        const pick = choice(candidates);
        tempState.teams[pick].players.push(nm);
      }
    }
    // prepare output
    const outLines = ['🎲 نتیجهٔ تیم‌بندی (داخل بات):', ''];
    const emojis = ['🔵 تیم 1','🟢 تیم 2','🟡 تیم 3','🟠 تیم 4'];
    for (let i=0;i<tempState.teamsCount;i++){
      outLines.push(`${emojis[i]}:`);
      if (tempState.teams[i].keeper) outLines.push(`🧤 ${tempState.teams[i].keeper}`);
      tempState.teams[i].players.forEach(p => outLines.push(`⚽ ${p}`));
      if (tempState.teams[i].subs.length) {
        outLines.push('🔄 تعویضی‌ها:');
        tempState.teams[i].subs.forEach(s => outLines.push(`  ▫️ ${s}`));
      }
      outLines.push('');
    }
    delete privateFlows[ctx.from.id];
    return ctx.reply(outLines.join('\n'));
  }
});

// ---------------- group flow ----------------

// admin command to start team in group
bot.command('start_team', async ctx => {
  if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.reply('این دستور فقط داخل گروه کار می‌کند.');
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    if (!['administrator','creator'].includes(member.status)) return ctx.reply('⛔ فقط ادمین می‌تواند اجرا کند.');
  } catch (e) { /* ignore */ }
  await ctx.reply('🧮 چند تیم؟', Markup.inlineKeyboard([
    [Markup.button.callback('2️⃣ ۲ تیم','g_choose:2'), Markup.button.callback('3️⃣ ۳ تیم','g_choose:3')],
    [Markup.button.callback('4️⃣ ۴ تیم','g_choose:4')]
  ]));
});

// when bot is added to group -> optionally prompt
bot.on('my_chat_member', async ctx => {
  try {
    const mc = ctx.update.my_chat_member;
    if (!mc) return;
    const newStatus = mc.new_chat_member && mc.new_chat_member.status;
    const chat = mc.chat;
    if ((newStatus === 'member' || newStatus === 'administrator') && (chat.type === 'group' || chat.type === 'supergroup')) {
      // prompt admin to run /start_team or we can auto prompt team choice
      try { await bot.telegram.sendMessage(chat.id, 'سلام! برای شروع تیم‌چینی ادمین لطفاً /start_team را اجرا کند.'); } catch (e) {}
    }
  } catch (e) {}
});

// group choose team count
bot.action(/g_choose:(\d+)/, async ctx => {
  if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.answerCbQuery();
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    if (!['administrator','creator'].includes(member.status)) return ctx.answerCbQuery('فقط ادمین می‌تواند انتخاب کند.');
  } catch (e) { return ctx.answerCbQuery('خطا'); }

  const n = Number(ctx.match[1]);
  const chatId = ctx.chat.id;
  await withGroupLock(chatId, async () => {
    const state = ensureChatState(chatId, n);
    state.teamsCount = n;
    state.teams = Array.from({ length: n }, () => ({ keeper: null, players: [], subs: [] }));
    state.registered = {};
    // mark admin
    if (!state.adminIds.includes(String(ctx.from.id))) state.adminIds.push(String(ctx.from.id));
    // send initial message (store message_id)
    const sent = await ctx.reply(formatTeamsText(state), { reply_markup: buildKeyboard() });
    state.message_id = sent.message_id;
    saveStore(store);
    // immediate safe edit to ensure keyboard present
    await safeEditMessage(chatId, state.message_id, formatTeamsText(state), buildKeyboard());
  });
  await ctx.answerCbQuery();
});

// join handlers
bot.action('join_player', async ctx => {
  if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.answerCbQuery('این دکمه فقط در گروه کار می‌کند.');
  const chatId = ctx.chat.id;
  await withGroupLock(chatId, async () => {
    const state = store.chats[String(chatId)];
    if (!state) return ctx.answerCbQuery('فعالی نیست.');
    const uid = String(ctx.from.id);
    if (state.registered[uid]) return ctx.answerCbQuery('⛔ شما قبلاً ثبت‌نام کردید.');
    const res = assignEntry(state, { id: uid, name: displayName(ctx.from), role: 'player' });
    if (!res.ok) return ctx.answerCbQuery('ثبت نام امکان‌پذیر نیست.');
    await ctx.answerCbQuery(res.substitute ? 'شما به عنوان تعویضی ثبت شدید.' : '✅ ثبت شد');
    // edit message with keyboard intact
    await safeEditMessage(chatId, state.message_id, formatTeamsText(state), buildKeyboard());
  });
});

bot.action('join_keeper', async ctx => {
  if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.answerCbQuery('این دکمه فقط در گروه کار می‌کند.');
  const chatId = ctx.chat.id;
  await withGroupLock(chatId, async () => {
    const state = store.chats[String(chatId)];
    if (!state) return ctx.answerCbQuery('فعالی نیست.');
    const uid = String(ctx.from.id);
    if (state.registered[uid]) return ctx.answerCbQuery('⛔ شما قبلاً ثبت‌نام کردید.');
    const slot = chooseKeeperTeam(state);
    if (slot === null) return ctx.answerCbQuery('همهٔ تیم‌ها دروازه‌بان دارند.');
    const res = assignEntry(state, { id: uid, name: displayName(ctx.from), role: 'keeper' });
    if (!res.ok) return ctx.answerCbQuery('ثبت نام ممکن نیست.');
    await ctx.answerCbQuery('🧤 دروازه‌بان ثبت شد');
    await safeEditMessage(chatId, state.message_id, formatTeamsText(state), buildKeyboard());
  });
});

// reshuffle (admin only)
bot.action('reshuffle', async ctx => {
  if (!['group','supergrou
