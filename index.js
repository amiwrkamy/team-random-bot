// index.js — Final robust team-random bot
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('ERROR: set BOT_TOKEN in .env or environment');
  process.exit(1);
}

// delete webhook (if any) to ensure polling works
const deleteWebhookUrl = `https://api.telegram.org/bot${TOKEN}/deleteWebhook`;
const https = require('https');
https.get(deleteWebhookUrl, () => { /* ignore response */ });

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('✅ Bot started (polling)');

// -------------------- In-memory state --------------------
// groupSessions[chatId] = {
//   teamsCount: 2|3|4,
//   registered: Map(userId => { id, name, role }), // role: 'player'|'gk'
//   assignments: Map(userId => teamIndex|'sub'),
//   messageId: number|null
// }
const groupSessions = new Map();

// privateSessions[userId] = { teamsCount, step: 'await_gk'|'await_players', gks:[], players:[] }
const privateSessions = new Map();

// per-chat lock to avoid race conditions
const locks = new Map();
async function withLock(key, fn) {
  while (locks.get(key)) await new Promise(r => setTimeout(r, 15));
  locks.set(key, true);
  try { return await fn(); } finally { locks.set(key, false); }
}

// -------------------- Utilities --------------------
function shuffle(arr) {
  if (!Array.isArray(arr)) return [];
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function isAdmin(chatId, userId) {
  try {
    const admins = await bot.getChatAdministrators(chatId);
    return admins.some(a => a.user && a.user.id === userId);
  } catch (e) {
    return false;
  }
}

// safe edit: always pass reply_markup; if edit fails -> send new and store id
async function safeEdit(chatId, messageId, text, replyMarkup) {
  try {
    if (messageId) {
      await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup,
        parse_mode: 'HTML'
      });
      return messageId;
    } else {
      const sent = await bot.sendMessage(chatId, text, { reply_markup: replyMarkup, parse_mode: 'HTML' });
      return sent.message_id;
    }
  } catch (err) {
    // fallback: send new message
    try {
      const sent = await bot.sendMessage(chatId, text, { reply_markup: replyMarkup, parse_mode: 'HTML' });
      return sent.message_id;
    } catch (e) {
      console.error('safeEdit fallback failed', e && e.message);
      return null;
    }
  }
}

// -------------------- Keyboards --------------------
function startModeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🤖 داخل ربات', callback_data: 'MODE_PRIVATE' }],
      [{ text: '👥 داخل گروه', callback_data: 'MODE_GROUP' }]
    ]
  };
}
function teamCountKeyboard(prefix = 'G') {
  return {
    inline_keyboard: [
      [{ text: '2️⃣ ۲ تیم', callback_data: `${prefix}_TEAMS_2` }],
      [{ text: '3️⃣ ۳ تیم', callback_data: `${prefix}_TEAMS_3` }],
      [{ text: '4️⃣ ۴ تیم', callback_data: `${prefix}_TEAMS_4` }]
    ]
  };
}
function groupJoinKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '⚽ من بازیکن‌ام', callback_data: 'JOIN_PLAYER' },
        { text: '🧤 من دروازه‌بان‌ام', callback_data: 'JOIN_GK' }
      ],
      [{ text: '🔀 قاطی‌کردن دوباره (ادمین)', callback_data: 'RESHUFFLE' }]
    ]
  };
}

// -------------------- Rendering / Assignment --------------------
function buildTeamsFromAssignments(session) {
  const teams = Array.from({ length: session.teamsCount }, () => ({ gk: null, players: [] }));
  const subs = [];

  for (const [uid, ent] of session.registered.entries()) {
    const assigned = session.assignments.get(uid);
    if (assigned === undefined || assigned === 'sub') {
      subs.push(ent.name);
    } else {
      const idx = assigned;
      if (ent.role === 'gk') teams[idx].gk = ent.name;
      else teams[idx].players.push(ent.name);
    }
  }
  return { teams, subs };
}

function renderSessionText(session) {
  const { teams, subs } = buildTeamsFromAssignments(session);
  let text = '<b>🏆 وضعیت تیم‌ها (لایو)</b>\n\n';
  teams.forEach((t, i) => {
    const count = (t.gk ? 1 : 0) + t.players.length;
    text += `<b>🔵 تیم ${i + 1} — ${count} نفر</b>\n`;
    if (t.gk) text += `🧤 ${escapeHtml(t.gk)}\n`;
    if (t.players.length) text += t.players.map(p => `⚽ ${escapeHtml(p)}`).join('\n') + '\n';
    if (!t.gk && t.players.length === 0) text += '—\n';
    text += '\n';
  });
  if (subs.length) text += `<b>🔄 تعویضی‌ها:</b>\n` + subs.map(s => `▫️ ${escapeHtml(s)}`).join('\n') + '\n\n';
  text += '📌 هر نفر فقط یک‌بار ثبت‌نام کند.\n';
  text += '👑 فقط ادمین می‌تواند «🔀 قاطی‌کردن دوباره» را بزند.';
  return text;
}
function escapeHtml(s) {
  if (!s) return '';
  return s.replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
}

// Choose team for GK: among teams without GK, choose those with minimal size, then random
function chooseTeamForGK(session) {
  const teamCount = session.teamsCount;
  const sizes = new Array(teamCount).fill(0);
  const hasGK = new Array(teamCount).fill(false);

  for (const [uid, tIdx] of session.assignments.entries()) {
    if (tIdx === 'sub') continue;
    const ent = session.registered.get(uid);
    if (!ent) continue;
    sizes[tIdx] += 1; // both player or gk count as 1
    if (ent.role === 'gk') hasGK[tIdx] = true;
  }

  let min = Infinity;
  const candidates = [];
  for (let i = 0; i < teamCount; i++) {
    if (hasGK[i]) continue;
    if (sizes[i] < min) { min = sizes[i]; candidates.length = 0; candidates.push(i); }
    else if (sizes[i] === min) candidates.push(i);
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// Choose team for player: among teams with size < 5, pick ones with minimal size then random
function chooseTeamForPlayer(session) {
  const teamCount = session.teamsCount;
  const sizes = new Array(teamCount).fill(0);
  for (const [uid, tIdx] of session.assignments.entries()) {
    if (tIdx === 'sub') continue;
    const ent = session.registered.get(uid);
    if (!ent) continue;
    sizes[tIdx] += 1;
  }
  const min = Math.min(...sizes);
  const candidates = [];
  for (let i = 0; i < teamCount; i++) {
    if (sizes[i] === min && sizes[i] < 5) candidates.push(i);
  }
  if (candidates.length === 0) {
    // fallback: allow teams with size < 5 (even if not min) to accept overflow
    for (let i = 0; i < teamCount; i++) if (sizes[i] < 5) candidates.push(i);
    if (candidates.length === 0) return null;
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// assign single new entry immediately
function assignSingle(session, entry) {
  // ensure session.assignments exists
  if (!session.assignments) session.assignments = new Map();
  if (entry.role === 'gk') {
    const idx = chooseTeamForGK(session);
    if (idx === null) {
      session.assignments.set(entry.id, 'sub'); return 'sub';
    }
    session.assignments.set(entry.id, idx); return idx;
  } else {
    const idx = chooseTeamForPlayer(session);
    if (idx === null) {
      session.assignments.set(entry.id, 'sub'); return 'sub';
    }
    session.assignments.set(entry.id, idx); return idx;
  }
}

// full initial distribution from registered map (used for reshuffle and private distribution)
function distributeAll(session) {
  session.assignments = new Map();
  const entries = Array.from(session.registered.entries()).map(([id, e]) => ({ id, ...e }));
  const gks = shuffle(entries.filter(e => e.role === 'gk'));
  const players = shuffle(entries.filter(e => e.role === 'player'));
  // assign GK up to teamsCount
  for (let i = 0; i < Math.min(gks.length, session.teamsCount); i++) session.assignments.set(gks[i].id, i);
  // extras GK become players
  for (let i = session.teamsCount; i < gks.length; i++) players.push(gks[i]);
  // assign players iteratively balancing
  for (const p of players) {
    const idx = chooseTeamForPlayer(session);
    if (idx === null) session.assignments.set(p.id, 'sub');
    else session.assignments.set(p.id, idx);
  }
  // ensure all registered have assignment
  for (const [id] of session.registered.entries()) if (!session.assignments.has(id)) session.assignments.set(id, 'sub');
}

// -------------------- Handlers --------------------

// PRIVATE /start -> mode selection
bot.onText(/\/start$/, async (msg) => {
  if (msg.chat.type !== 'private') return;
  await bot.sendMessage(msg.chat.id, '🎯 تیم‌چینی — حالت را انتخاب کن:', { reply_markup: startModeKeyboard() });
});

// MODE callbacks & team count selection (private or group)
bot.on('callback_query', async (q) => {
  const data = q.data;
  const chatId = q.message.chat.id;
  const from = q.from;

  // MODE: PRIVATE
  if (data === 'MODE_PRIVATE') {
    await bot.answerCallbackQuery(q.id);
    await bot.editMessageText('🔢 چند تیم می‌خوای؟', {
      chat_id: chatId,
      message_id: q.message.message_id,
      reply_markup: teamCountKeyboard('P')
    }).catch(async () => {
      await bot.sendMessage(chatId, '🔢 چند تیم می‌خوای؟', { reply_markup: teamCountKeyboard('P') });
    });
    return;
  }

  // MODE: GROUP -> show add-to-group link
  if (data === 'MODE_GROUP') {
    await bot.answerCallbackQuery(q.id);
    try {
      const me = await bot.getMe();
      const url = `https://t.me/${me.username}?startgroup=true`;
      await bot.editMessageText('➕ برای استفاده، ربات را به گروه اضافه کنید:', {
        chat_id: chatId,
        message_id: q.message.message_id,
        reply_markup: { inline_keyboard: [[{ text: '➕ افزودن به گروه', url }]] }
      });
    } catch (e) {
      await bot.sendMessage(chatId, '➕ برای استفاده، ربات را به گروه اضافه کنید (مشکل در گرفتن نام ربات).');
    }
    return;
  }

  // Private team count selected (P_TEAMS_n)
  if (data && data.startsWith('P_TEAMS_')) {
    await bot.answerCallbackQuery(q.id);
    const n = Number(data.split('_')[2]);
    // create private session for this user (keyed by user's chat id)
    privateSessions.set(chatId, { teamsCount: n, step: 'await_gks', gks: [], players: [] });
    // Ask for GK names first
    await bot.editMessageText('✍️ لطفاً ابتدا نام دروازه‌بان‌ها را هر خط یک اسم ارسال کن (حداقل تا تعداد تیم‌ها را وارد کن). سپس من ازت نام بازیکنان را می‌گیرم.', {
      chat_id: chatId, message_id: q.message.message_id
    }).catch(() => {
      bot.sendMessage(chatId, '✍️ ابتدا نام دروازه‌بان‌ها را هر خط یک اسم ارسال کن.');
    });
    return;
  }

  // Group team count selected (G_TEAMS_n)
  if (data && data.startsWith('G_TEAMS_')) {
    await bot.answerCallbackQuery(q.id);
    const n = Number(data.split('_')[2]);
    // initialize or reset group session
    await withLock(chatId, async () => {
      let session = groupSessions.get(chatId);
      if (!session) {
        session = { teamsCount: n, registered: new Map(), assignments: new Map(), messageId: null };
        groupSessions.set(chatId, session);
      } else {
        session.teamsCount = n;
        session.registered = new Map();
        session.assignments = new Map();
        session.messageId = null;
        groupSessions.set(chatId, session);
      }
      // send live board with join keyboard
      const text = renderSessionText(session);
      const sent = await bot.sendMessage(chatId, text, { reply_markup: groupJoinKeyboard(), parse_mode: 'HTML' });
      session.messageId = sent.message_id;
    });
    return;
  }

  // Now group join/reshuffle actions
  if (['JOIN_PLAYER', 'JOIN_GK', 'RESHUFFLE'].includes(data)) {
    const session = groupSessions.get(chatId);
    if (!session) {
      await bot.answerCallbackQuery(q.id, { text: 'جلسه فعال نیست. در گروه /start_team را اجرا کنید.', show_alert: true });
      return;
    }

    await withLock(chatId, async () => {
      const userId = String(from.id);
      const name = from.username ? `@${from.username}` : (from.first_name || String(from.id));

      // RESHUFFLE (admin only)
      if (data === 'RESHUFFLE') {
        const admin = await isAdmin(chatId, from.id);
        if (!admin) {
          await bot.answerCallbackQuery(q.id, { text: '❌ فقط ادمین می‌تواند قاطی کند', show_alert: true });
          return;
        }
        // keep registered list, redistribute
        distributeAll(session);
        // update message (safe)
        session.messageId = await safeEdit(chatId, session.messageId, renderSessionText(session), groupJoinKeyboard());
        await bot.answerCallbackQuery(q.id, { text: '🔀 تیم‌ها دوباره شانسی شدند' });
        return;
      }

      // JOIN: check duplicate (user already registered)
      if (session.registered.has(userId)) {
        await bot.answerCallbackQuery(q.id, { text: '⚠️ قبلاً ثبت‌نام کرده‌ای', show_alert: true });
        return;
      }

      // JOIN_GK
      if (data === 'JOIN_GK') {
        // count current GK assigned in registered
        const currentGkCount = Array.from(session.registered.values()).filter(e => e.role === 'gk').length;
        if (currentGkCount >= session.teamsCount) {
          await bot.answerCallbackQuery(q.id, { text: '❌ تعداد دروازه‌بان‌ها تکمیل شده', show_alert: true });
          return;
        }
        session.registered.set(userId, { id: userId, name, role: 'gk' });
        // assign immediately
        assignSingle(session, { id: userId, name, role: 'gk' });
        session.messageId = await safeEdit(chatId, session.messageId, renderSessionText(session), groupJoinKeyboard());
        await bot.answerCallbackQuery(q.id, { text: '🧤 دروازه‌بان ثبت شد' });
        return;
      }

      // JOIN_PLAYER
      if (data === 'JOIN_PLAYER') {
        session.registered.set(userId, { id: userId, name, role: 'player' });
        assignSingle(session, { id: userId, name, role: 'player' });
        session.messageId = await safeEdit(chatId, session.messageId, renderSessionText(session), groupJoinKeyboard());
        await bot.answerCallbackQuery(q.id, { text: '✅ ثبت شد' });
        return;
      }
    }); // end lock
    return;
  }

  // unknown callback, answer to avoid 'loading' on client
  await bot.answerCallbackQuery(q.id).catch(() => {});
});

// -------------------- /start_team command in group --------------------
bot.onText(/\/start_team/, async (msg) => {
  if (!msg.chat) return;
  if (!['group', 'supergroup'].includes(msg.chat.type)) {
    return bot.sendMessage(msg.chat.id, 'این دستور فقط در گروه قابل اجراست.');
  }
  // require admin to start
  try {
    const admin = await isAdmin(msg.chat.id, msg.from.id);
    if (!admin) return bot.sendMessage(msg.chat.id, '⛔ فقط ادمین می‌تواند شروع کند.');
  } catch (e) {
    // ignore permission check failure
  }
  await bot.sendMessage(msg.chat.id, '🔢 تعداد تیم‌ها را انتخاب کنید:', { reply_markup: teamCountKeyboard('G') });
});

// -------------------- Private message handler for collecting names --------------------
bot.on('message', async (msg) => {
  if (!msg || !msg.chat) return;
  // private flow names collection
  if (msg.chat.type === 'private') {
    const userKey = String(msg.chat.id);
    const ps = privateSessions.get(userKey);
    if (!ps) return;
    if (!ps.step) return;

    // Expecting text body
    if (!msg.text) return;

    // If waiting for GKs list
    if (ps.step === 'await_gks') {
      const lines = msg.text.split('\n').map(l => l.trim()).filter(Boolean);
      ps.gks = lines;
      ps.step = 'await_players';
      privateSessions.set(userKey, ps);
      await bot.sendMessage(msg.chat.id, `✅ دریافت دروازه‌بان‌ها (${ps.gks.length})\nحالا لطفاً اسامی بازیکن‌ها را هر خط یک اسم ارسال کن.`);
      return;
    }

    // If waiting for players
    if (ps.step === 'await_players') {
      const lines = msg.text.split('\n').map(l => l.trim()).filter(Boolean);
      ps.players = lines;
      // Build a temp session and distribute
      const tempSession = {
        teamsCount: ps.teamsCount,
        registered: new Map(),
        assignments: new Map()
      };
      // add GK entries
      let counter = 1;
      for (const name of ps.gks) {
        tempSession.registered.set(`gk_${counter++}`, { id: `gk_${counter}`, name, role: 'gk' });
      }
      for (const name of ps.players) {
        tempSession.registered.set(`p_${counter++}`, { id: `p_${counter}`, name, role: 'player' });
      }
      distributeAll(tempSession);
      // render teams
      const { teams, subs } = buildTeamsFromAssignments(tempSession);
      let out = '<b>🎲 نتیجهٔ داخل ربات</b>\n\n';
      teams.forEach((t, i) => {
        const count = (t.gk ? 1 : 0) + t.players.length;
        out += `<b>🔹 تیم ${i + 1} — ${count} نفر</b>\n`;
        if (t.gk) out += `🧤 ${escapeHtml(t.gk)}\n`;
        if (t.players.length) out += t.players.map(p => `⚽ ${escapeHtml(p)}`).join('\n') + '\n';
        out += '\n';
      });
      if (subs.length) out += `<b>🔄 تعویضی‌ها:</b>\n${subs.map(s => `▫️ ${escapeHtml(s)}`).join('\n')}\n`;
      await bot.sendMessage(msg.chat.id, out, { parse_mode: 'HTML' });
      privateSessions.delete(userKey);
      return;
    }
  } // end private message handler
}); // end bot.on message

// -------------------- Helper: buildTeamsFromAssignments for private output --------------------
function buildTeamsFromAssignments(session) {
  const teams = Array.from({ length: session.teamsCount }, () => ({ gk: null, players: [] }));
  const subs = [];
  for (const [uid, ent] of session.registered.entries()) {
    const assigned = session.assignments.get(uid);
    if (assigned === undefined || assigned === 'sub') subs.push(ent.name);
    else {
      if (ent.role === 'gk') teams[assigned].gk = ent.name;
      else teams[assigned].players.push(ent.name);
    }
  }
  return { teams, subs };
}

// -------------------- finish: startup message --------------------
console.log('✅ Ready. Use /start in private and /start_team in group.');

// -------------------- Expose small helper to start private flow from callback (P_TEAMS handlers) --------------------
bot.on('callback_query', async (q) => {
  // handle P_TEAMS callbacks already handled above, but ensure privateSessions created for users who clicked earlier flows
  try {
    if (q.data && q.data.startsWith('P_TEAMS_')) {
      const n = Number(q.data.split('_')[2]);
      const chatId = q.message.chat.id;
      privateSessions.set(String(chatId), { teamsCount: n, step: 'await_gks', gks: [], players: [] });
      await bot.answerCallbackQuery(q.id);
      await bot.editMessageText('✍️ لطفاً نام دروازه‌بان‌ها را هر خط یک اسم ارسال کنید (حداقل همان تعداد تیم).', {
        chat_id: chatId, message_id: q.message.message_id
      }).catch(() => {
        await bot.sendMessage(chatId, '✍️ لطفاً نام دروازه‌بان‌ها را هر خط یک اسم ارسال کنید (حداقل همان تعداد تیم).');
      });
    }
  } catch (e) {
    // ignore
  }
});
