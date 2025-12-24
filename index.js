// index.js
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('ERROR: BOT_TOKEN environment variable is required.');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('✅ Bot started (polling)');

/**
 * Data structures (in-memory)
 * groupSessions: Map<chatId, session>
 * session = {
 *   teamsCount: number,
 *   registered: Map<userId, { id, name, role }>,
 *   assignments: Map<userId, teamIndex | 'sub'>,
 *   messageId: number | null
 * }
 */
const groupSessions = new Map();
const privateSessions = new Map();
const locks = new Map(); // chatId -> boolean for simple lock

// ---------- utils ----------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function withLock(chatId, fn) {
  while (locks.get(chatId)) await sleep(20);
  locks.set(chatId, true);
  try { return await fn(); } finally { locks.set(chatId, false); }
}
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
async function safeEditText(chatId, messageId, text, replyMarkup) {
  try {
    if (messageId) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
      return messageId;
    } else {
      const sent = await bot.sendMessage(chatId, text, { reply_markup: replyMarkup });
      return sent.message_id;
    }
  } catch (err) {
    // fallback: send a new message and return its id
    try {
      const sent = await bot.sendMessage(chatId, text, { reply_markup: replyMarkup });
      return sent.message_id;
    } catch (e) {
      console.error('safeEditText failed:', e && e.message);
      return null;
    }
  }
}

// ---------- keyboards ----------
function startModeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🤖 داخل ربات', callback_data: 'MODE_PRIVATE' }],
      [{ text: '👥 داخل گروه', callback_data: 'MODE_GROUP' }]
    ]
  };
}
function teamCountKeyboard(prefix='G') {
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

// ---------- rendering ----------
function buildTeamsFromAssignments(session) {
  const teams = Array.from({ length: session.teamsCount }, () => ({ gk: null, players: [] }));
  const subs = [];
  for (const [uid, ent] of session.registered.entries()) {
    const assign = session.assignments.get(uid);
    if (assign === undefined || assign === 'sub') {
      subs.push(ent.name);
    } else {
      if (ent.role === 'gk') teams[assign].gk = ent.name;
      else teams[assign].players.push(ent.name);
    }
  }
  return { teams, subs };
}
function renderGroupText(session) {
  const { teams, subs } = buildTeamsFromAssignments(session);
  let text = '🏆 تیم‌چینی (لایو)\n\n';
  teams.forEach((t, i) => {
    const count = (t.gk ? 1 : 0) + t.players.length;
    text += `🔵 تیم ${i + 1} — ${count} نفر\n`;
    if (t.gk) text += `🧤 ${t.gk}\n`;
    if (t.players.length) text += t.players.map(p => `⚽ ${p}`).join('\n') + '\n';
    if (!t.gk && t.players.length === 0) text += '—\n';
    text += '\n';
  });
  if (subs.length) text += '🔄 تعویضی‌ها:\n' + subs.map(s => `▫️ ${s}`).join('\n') + '\n\n';
  text += '📌 هر نفر فقط یک‌بار ثبت‌نام کند.\n';
  text += '👑 فقط ادمین می‌تواند «🔀 قاطی‌کردن دوباره» را بزند.';
  return text;
}

// ---------- assignment helpers ----------
function chooseTeamForGK(session) {
  // teams without GK; among them choose those with smallest size (players + (gk?1:0)), then random
  const sizes = [];
  for (let i = 0; i < session.teamsCount; i++) {
    let s = 0;
    for (const [uid, tIdx] of session.assignments.entries()) {
      if (tIdx === i) {
        const ent = session.registered.get(uid);
        if (ent) s += 1;
      }
    }
    sizes.push(s);
  }
  let min = Infinity; const candidates = [];
  for (let i = 0; i < session.teamsCount; i++) {
    // check if team already has a GK
    let hasGK = false;
    for (const [uid, tIdx] of session.assignments.entries()) {
      if (tIdx === i) {
        const ent = session.registered.get(uid);
        if (ent && ent.role === 'gk') { hasGK = true; break; }
      }
    }
    if (hasGK) continue;
    if (sizes[i] < min) { min = sizes[i]; candidates.length = 0; candidates.push(i); }
    else if (sizes[i] === min) candidates.push(i);
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
function chooseTeamForPlayer(session) {
  // find teams with minimal size (<5)
  const sizes = [];
  for (let i = 0; i < session.teamsCount; i++) {
    let s = 0;
    for (const [uid, tIdx] of session.assignments.entries()) {
      if (tIdx === i) s += 1;
    }
    sizes.push(s);
  }
  const min = Math.min(...sizes);
  const candidates = [];
  for (let i = 0; i < session.teamsCount; i++) {
    if (sizes[i] === min && sizes[i] < 5) candidates.push(i);
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}
function assignSingleEntry(session, entry) {
  // entry = { id, name, role }
  if (!session.assignments) session.assignments = new Map();
  if (entry.role === 'gk') {
    const idx = chooseTeamForGK(session);
    if (idx === null) {
      session.assignments.set(entry.id, 'sub');
      return 'sub';
    }
    session.assignments.set(entry.id, idx);
    return idx;
  } else {
    const idx = chooseTeamForPlayer(session);
    if (idx === null) {
      session.assignments.set(entry.id, 'sub');
      return 'sub';
    }
    session.assignments.set(entry.id, idx);
    return idx;
  }
}
function initialDistribute(session) {
  // far: reassign all registered randomly but balanced
  session.assignments = new Map();
  const all = Array.from(session.registered.entries()).map(([id, ent]) => ({ id, ...ent }));
  const gks = shuffleArray(all.filter(x => x.role === 'gk'));
  const players = shuffleArray(all.filter(x => x.role === 'player'));
  // assign GK up to teamsCount
  for (let i = 0; i < Math.min(gks.length, session.teamsCount); i++) {
    session.assignments.set(gks[i].id, i);
  }
  // extras GK become players
  for (let i = session.teamsCount; i < gks.length; i++) players.push(gks[i]);
  // assign players balanced
  for (const p of players) {
    const idx = chooseTeamForPlayer(session);
    if (idx === null) session.assignments.set(p.id, 'sub');
    else session.assignments.set(p.id, idx);
  }
  // ensure any missing registered assigned to sub
  for (const [id] of session.registered.entries()) if (!session.assignments.has(id)) session.assignments.set(id, 'sub');
}

// ---------- parse private names ----------
function parsePrivateNames(text, teamsCount) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  // try to detect sections
  const lower = text.toLowerCase();
  let gks = [], players = [];
  let idxGK = -1, idxPlayers = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if (l.startsWith('gk:') || l.startsWith('goalkeepers:') || l.includes('دروازه')) { idxGK = i; break; }
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if (l.startsWith('players:') || l.includes('بازیکن')) { idxPlayers = i; break; }
  }
  if (idxGK >= 0) {
    // collect GK lines
    for (let i = idxGK + 1; i < (idxPlayers >= 0 ? idxPlayers : lines.length); i++) gks.push(lines[i]);
    if (idxPlayers >= 0) {
      for (let i = idxPlayers + 1; i < lines.length; i++) players.push(lines[i]);
    } else {
      // remaining after GK are players
      for (let i = idxGK + gks.length + 1; i < lines.length; i++) players.push(lines[i]);
    }
  } else if (idxPlayers >= 0) {
    // only players section
    for (let i = idxPlayers + 1; i < lines.length; i++) players.push(lines[i]);
  } else {
    // fallback: first N lines GK, rest players
    gks = lines.slice(0, teamsCount);
    players = lines.slice(teamsCount);
  }
  return { gks, players };
}

// ---------- bot handlers ----------

// /start in private -> show mode
bot.onText(/\/start/, (msg) => {
  if (msg.chat.type !== 'private') return;
  bot.sendMessage(msg.chat.id, '🎯 تیم‌چینی — انتخاب حالت:', { reply_markup: startModeKeyboard() });
});

// callback queries for mode selection and team count
bot.on('callback_query', async (q) => {
  const data = q.data;
  const chatId = q.message.chat.id;
  const fromId = q.from.id;

  // MODE_PRIVATE
  if (data === 'MODE_PRIVATE') {
    await bot.answerCallbackQuery(q.id);
    try {
      await bot.editMessageText('🔢 چند تیم می‌خواهی؟', { chat_id: chatId, message_id: q.message.message_id, reply_markup: teamCountKeyboard('P') });
    } catch (e) {
      await bot.sendMessage(chatId, '🔢 چند تیم می‌خواهی?', { reply_markup: teamCountKeyboard('P') });
    }
    return;
  }

  // MODE_GROUP
  if (data === 'MODE_GROUP') {
    await bot.answerCallbackQuery(q.id);
    const me = await bot.getMe();
    const url = `https://t.me/${me.username}?startgroup=true`;
    try {
      await bot.editMessageText('➕ برای استفاده، ربات را به گروه خود اضافه کنید:', { chat_id: chatId, message_id: q.message.message_id, reply_markup: { inline_keyboard: [[{ text: '➕ افزودن به گروه', url }]] } });
    } catch (e) {
      await bot.sendMessage(chatId, '➕ برای استفاده، ربات را به گروه خود اضافه کنید:', { reply_markup: { inline_keyboard: [[{ text: '➕ افزودن به گروه', url }]] } });
    }
    return;
  }

  // Private team count selected
  if (data && data.startsWith('P_TEAMS_')) {
    await bot.answerCallbackQuery(q.id);
    const n = Number(data.split('_')[2]);
    privateSessions.set(chatId, { teamsCount: n, awaitingNames: true });
    try {
      await bot.editMessageText('✍️ حالا اسامی را بفرست (هر خط یک اسم). اگر می‌خواهی دروازه‌بان مشخص کنی، از خط شروع با "GK:" و سپس "PLAYERS:" استفاده کن.\nمثال:\nGK:\nAli\nReza\nPLAYERS:\nAmir\nSina', { chat_id: chatId, message_id: q.message.message_id });
    } catch (e) {
      await bot.sendMessage(chatId, '✍️ حالا اسامی را بفرست (هر خط یک اسم). اگر می‌خواهی دروازه‌بان مشخص کنی، از GK: و PLAYERS: استفاده کن.');
    }
    return;
  }

  // Group team count selected
  if (data && data.startsWith('G_TEAMS_')) {
    await bot.answerCallbackQuery(q.id);
    const n = Number(data.split('_')[2]);
    // initialize session
    const s = {
      teamsCount: n,
      registered: new Map(),
      assignments: new Map(),
      messageId: null
    };
    groupSessions.set(chatId, s);
    const text = renderGroupText(s);
    const sent = await bot.sendMessage(chatId, text, { reply_markup: groupJoinKeyboard() });
    s.messageId = sent.message_id;
    groupSessions.set(chatId, s);
    return;
  }

  // Group join / reshuffle
  if (['JOIN_PLAYER', 'JOIN_GK', 'RESHUFFLE'].includes(data)) {
    const s = groupSessions.get(chatId);
    if (!s) {
      await bot.answerCallbackQuery(q.id, { text: 'جلسه‌ای فعال نیست. ابتدا در گروه /start_team را اجرا کنید', show_alert: true });
      return;
    }

    await withLock(chatId, async () => {
      // JOIN_PLAYER
      if (data === 'JOIN_PLAYER') {
        const uid = String(q.from.id);
        if (s.registered.has(uid)) {
          await bot.answerCallbackQuery(q.id, { text: '❌ قبلاً ثبت‌نام کرده‌اید', show_alert: true });
          return;
        }
        s.registered.set(uid, { id: uid, name: q.from.username ? `@${q.from.username}` : (q.from.first_name || 'User'), role: 'player' });
        // assign immediately
        assignSingleEntry(s, { id: uid, name: s.registered.get(uid).name, role: 'player' });
        s.messageId = await safeEditText(chatId, s.messageId, renderGroupText(s), groupJoinKeyboard());
        await bot.answerCallbackQuery(q.id, { text: '✅ ثبت شد' });
        groupSessions.set(chatId, s);
        return;
      }

      // JOIN_GK
      if (data === 'JOIN_GK') {
        const uid = String(q.from.id);
        if (s.registered.has(uid)) {
          await bot.answerCallbackQuery(q.id, { text: '❌ قبلاً ثبت‌نام کرده‌اید', show_alert: true });
          return;
        }
        // count current assigned gks
        let gkCount = 0;
        for (const [id, ent] of s.registered.entries()) if (ent.role === 'gk') gkCount++;
        if (gkCount >= s.teamsCount) {
          await bot.answerCallbackQuery(q.id, { text: '❌ همهٔ تیم‌ها دروازه‌بان دارند', show_alert: true });
          return;
        }
        s.registered.set(uid, { id: uid, name: q.from.username ? `@${q.from.username}` : (q.from.first_name || 'User'), role: 'gk' });
        assignSingleEntry(s, { id: uid, name: s.registered.get(uid).name, role: 'gk' });
        s.messageId = await safeEditText(chatId, s.messageId, renderGroupText(s), groupJoinKeyboard());
        await bot.answerCallbackQuery(q.id, { text: '🧤 دروازه‌بان ثبت شد' });
        groupSessions.set(chatId, s);
        return;
      }

      // RESHUFFLE
      if (data === 'RESHUFFLE') {
        // admin check
        try {
          const member = await bot.getChatMember(chatId, q.from.id);
          if (!['administrator', 'creator'].includes(member.status)) {
            await bot.answerCallbackQuery(q.id, { text: '⛔ فقط ادمین می‌تواند این کار را انجام دهد', show_alert: true });
            return;
          }
        } catch (e) {
          await bot.answerCallbackQuery(q.id, { text: 'خطا در بررسی دسترسی ادمین', show_alert: true });
          return;
        }

        // gather all, reshuffle
        const entries = Array.from(s.registered.entries()).map(([id, ent]) => ({ id, ...ent }));
        const gks = shuffleArray(entries.filter(e => e.role === 'gk'));
        const players = shuffleArray(entries.filter(e => e.role === 'player'));
        // reset
        s.assignments = new Map();
        // assign gks up to teamsCount
        for (let i = 0; i < Math.min(gks.length, s.teamsCount); i++) s.assignments.set(gks[i].id, i);
        // extras gks -> players
        for (let i = s.teamsCount; i < gks.length; i++) players.push(gks[i]);
        // assign players balanced
        for (const p of players) {
          const idx = chooseTeamForPlayer(s);
          if (idx === null) s.assignments.set(p.id, 'sub');
          else s.assignments.set(p.id, idx);
        }
        s.messageId = await safeEditText(chatId, s.messageId, renderGroupText(s), groupJoinKeyboard());
        await bot.answerCallbackQuery(q.id, { text: '🔀 دوباره شانسی شد' });
        groupSessions.set(chatId, s);
        return;
      }
    }); // end lock
  } // end group action handling

}); // end callback_query

// /start_team command to send team count keyboard (group usage)
bot.onText(/\/start_team/, async (msg) => {
  const chatId = msg.chat.id;
  if (!chatId) return;
  if (!['group', 'supergroup'].includes(msg.chat.type)) return bot.sendMessage(chatId, 'این دستور فقط در گروه استفاده می‌شود.');
  // only admin can call
  try {
    const member = await bot.getChatMember(chatId, msg.from.id);
    if (!['administrator', 'creator'].includes(member.status)) return bot.sendMessage(chatId, '⛔ فقط ادمین می‌تواند شروع کند.');
  } catch (e) { /* ignore */ }
  // send team count selector
  return bot.sendMessage(chatId, '🔢 تعداد تیم‌ها را انتخاب کنید:', { reply_markup: teamCountKeyboard('G') });
});

// private message handler for name submission (after P_TEAMS)
bot.on('message', async (msg) => {
  if (!msg.chat) return;
  if (msg.chat.type !== 'private') return;
  const key = msg.chat.id;
  const ps = privateSessions.get(key) || groupSessions.get(`private_${key}`) || groupSessions.get(`private_${key}`); // not used elsewhere
  // We used privateSessions Map earlier when P_TEAMS was selected. Let's check there:
  const privateState = privateSessions.get(key);
  if (!privateState) return;
  if (!privateState.awaitingNames) return;
  const text = (msg.text || '').trim();
  if (!text) return;
  // parse
  const { gks, players } = parsePrivateNames(text, privateState.teamsCount);
  // build a temp session to distribute and show result
  const temp = { teamsCount: privateState.teamsCount, registered: new Map(), assignments: new Map() };
  let counter = 1;
  for (const name of gks) { temp.registered.set(`gk_${counter++}`, { id: `gk_${counter}`, name, role: 'gk' }); }
  for (const name of players) { temp.registered.set(`p_${counter++}`, { id: `p_${counter}`, name, role: 'player' }); }
  initialDistribute(temp);
  const { teams, subs } = buildTeamsFromAssignments(temp);
  let out = '🎲 نتیجهٔ داخل ربات:\n\n';
  teams.forEach((t,i) => {
    out += `🔹 تیم ${i+1}\n`;
    if (t.gk) out += `🧤 ${t.gk}\n`;
    if (t.players.length) out += t.players.map(p => `⚽ ${p}`).join('\n') + '\n';
    out += '\n';
  });
  if (subs.length) out += '🔄 تعویضی‌ها:\n' + subs.join(', ') + '\n';
  await bot.sendMessage(key, out);
  privateSessions.delete(key);
});

// When P_TEAMS selected we store privateSessions
bot.on('callback_query', async (q) => {
  if (q.data && q.data.startsWith('P_TEAMS_')) {
    const n = Number(q.data.split('_')[2]);
    privateSessions.set(q.message.chat.id, { teamsCount: n, awaitingNames: true });
    await bot.answerCallbackQuery(q.id);
    try {
      await bot.editMessageText('✍️ لطفاً اسامی را بفرست (هر خط یک اسم). اگر میخواهی دروازه‌بان مشخص کنی از GK: استفاده کن.\nمثال:\nGK:\nAli\nReza\nPLAYERS:\nAmir\nSina', { chat_id: q.message.chat.id, message_id: q.message.message_id });
    } catch (e) {
      await bot.sendMessage(q.message.chat.id, '✍️ لطفاً اسامی را بفرست (هر خط یک اسم). مثال:\nGK:\\nAli\\nReza\\nPLAYERS:\\nAmir\\nSina');
    }
  }
});

// /status
bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  const s = groupSessions.get(chatId);
  if (!s) return bot.sendMessage(chatId, 'جلسه‌ای فعال نیست.');
  return bot.sendMessage(chatId, renderGroupText(s));
});

// /help
bot.onText(/\/help/, (msg) => {
  const help = [
    '/start در پرایوت -> حالت داخل ربات یا داخل گروه',
    '/start_team در گروه -> شروع تیم‌چینی (ادمین)',
    '/status -> نمایش وضعیت'
  ].join('\n');
  bot.sendMessage(msg.chat.id, help);
});

// Graceful error logging
bot.on('polling_error', (err) => {
  console.error('Polling error', err && err.message);
});
bot.on('error', (err) => {
  console.error('Bot error', err && err.message);
});
