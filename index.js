// index.js — Robust Random Team Bot (CommonJS)
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error('ERROR: BOT_TOKEN missing in .env');
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });
console.log('✅ Bot started');

// -------------------- Utilities & Locks --------------------
const locks = new Map();
async function withLock(key, fn) {
  while (locks.get(key)) await new Promise(r => setTimeout(r, 10));
  locks.set(key, true);
  try { return await fn(); } finally { locks.set(key, false); }
}
function shuffleArray(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function safeName(user) {
  if (!user) return 'Unknown';
  if (user.username) return `@${user.username}`;
  if (user.first_name && user.last_name) return `${user.first_name} ${user.last_name}`;
  return user.first_name || user.last_name || `id${user.id}`;
}

// -------------------- Sessions --------------------
// privateSessions: chatId -> { state: 'await_gks'|'await_players', teams, gks[], players[] }
const privateSessions = new Map();
// groupSessions: chatId -> { teams, registered: Map(userId-> {id,name,role}), statusMessageId, signupOpen }
const groupSessions = new Map();

// -------------------- Keyboards --------------------
function startModeKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🤖 داخل ربات', callback_data: 'MODE_PRIVATE' }],
      [{ text: '👥 داخل گروه', callback_data: 'MODE_GROUP' }]
    ]
  };
}
function teamsKeyboard(prefix = '') {
  return {
    inline_keyboard: [
      [{ text: '2️⃣ ۲ تیم', callback_data: `${prefix}TEAMS_2` }],
      [{ text: '3️⃣ ۳ تیم', callback_data: `${prefix}TEAMS_3` }],
      [{ text: '4️⃣ ۴ تیم', callback_data: `${prefix}TEAMS_4` }]
    ]
  };
}
function groupSignupKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '⚽ بازیکن', callback_data: 'JOIN_PLAYER' },
        { text: '🧤 دروازه‌بان', callback_data: 'JOIN_GK' }
      ],
      [{ text: '🔀 قاطی‌کردن دوباره (ادمین)', callback_data: 'RESHUFFLE' }]
    ]
  };
}

// -------------------- Safe edit/send (preserve keyboard) --------------------
async function safeEditOrSend(chatId, messageId, text, replyMarkup) {
  try {
    if (messageId) {
      await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup, parse_mode: 'HTML' });
      return messageId;
    } else {
      const sent = await bot.sendMessage(chatId, text, { reply_markup: replyMarkup, parse_mode: 'HTML' });
      return sent.message_id;
    }
  } catch (err) {
    // fallback send new message
    try {
      const sent = await bot.sendMessage(chatId, text, { reply_markup: replyMarkup, parse_mode: 'HTML' });
      return sent.message_id;
    } catch (e) {
      console.error('safeEditOrSend fallback failed:', e && e.message);
      return null;
    }
  }
}

// -------------------- Distribution logic --------------------
// Recompute distribution for a group session (returns assignments map userId -> index|'sub')
function distributeAllAssignments(sess) {
  const teamCount = sess.teams;
  // collect arrays
  const gkEntries = [];
  const playerEntries = [];
  for (const [id, ent] of sess.registered.entries()) {
    if (ent.role === 'gk') gkEntries.push({ id, name: ent.name });
    else playerEntries.push({ id, name: ent.name });
  }
  // shuffle copies
  const gks = shuffleArray(gkEntries);
  const players = shuffleArray(playerEntries);

  // assignments
  const assignments = new Map();
  // assign GK up to teamCount
  for (let i = 0; i < Math.min(gks.length, teamCount); i++) {
    assignments.set(String(gks[i].id), i);
  }
  // extra GK -> treat as player (append)
  for (let i = teamCount; i < gks.length; i++) players.push(gks[i]);

  // assign players trying to balance and keep <=5 per team
  const teamSizes = new Array(teamCount).fill(0);
  // count GK placeholders
  for (let i = 0; i < teamCount; i++) {
    if (i < gks.length) teamSizes[i] = 1; // GK present
  }
  for (const p of players) {
    // find teams with minimal size and size <5
    let minSize = Infinity;
    for (let i = 0; i < teamCount; i++) if (teamSizes[i] < minSize) minSize = teamSizes[i];
    // collect candidates with minSize and <5
    const candidates = [];
    for (let i = 0; i < teamCount; i++) {
      if (teamSizes[i] === minSize && teamSizes[i] < 5) candidates.push(i);
    }
    // if none, allow any with <5
    if (candidates.length === 0) {
      for (let i = 0; i < teamCount; i++) if (teamSizes[i] < 5) candidates.push(i);
    }
    if (candidates.length === 0) {
      assignments.set(String(p.id), 'sub');
    } else {
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      assignments.set(String(p.id), pick);
      teamSizes[pick] += 1;
    }
  }
  // ensure every registered has an assignment
  for (const id of sess.registered.keys()) if (!assignments.has(String(id))) assignments.set(String(id), 'sub');
  return assignments;
}

// Render text for live status (compact counts) — used while signups open
function renderLiveStatusText(sess) {
  const teamCount = sess.teams;
  // quick counts: compute approximate distribution for display
  const assignments = distributeAllAssignments(sess); // we use a copy's logic for counts
  const teams = Array.from({ length: teamCount }, () => []);
  const subs = [];
  for (const [id, ent] of sess.registered.entries()) {
    const asgn = assignments.get(String(id));
    if (asgn === 'sub') subs.push(ent.name);
    else teams[asgn].push(ent);
  }
  // compose
  let text = '<b>🏆 وضعیت تیم‌ها (لایو)</b>\n\n';
  teams.forEach((t, i) => {
    const count = t.length;
    const gkNames = t.filter(x => x.role === 'gk').map(x => x.name);
    text += `<b>🔵 تیم ${i+1} — ${count} نفر</b>\n`;
    if (gkNames.length) text += `🧤 ${escapeHtml(gkNames[0])}\n`;
    else text += `🧤 —\n`;
    const players = t.filter(x => x.role === 'player').map(x => x.name);
    if (players.length) text += players.map(p => `⚽ ${escapeHtml(p)}`).join('\n') + '\n';
    text += '\n';
  });
  text += `<b>🔄 تعویضی‌ها:</b> ${subs.length ? subs.map(s => escapeHtml(s)).join(', ') : '—'}\n\n`;
  text += '📌 هر نفر فقط یک‌بار می‌تواند ثبت‌نام کند.\n';
  text += '👑 فقط ادمین می‌تواند «🔀 قاطی‌کردن دوباره» را اجرا کند.';
  return text;
}
function escapeHtml(s) {
  if (!s) return '';
  return String(s).replace(/[&<>]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;' }[c]));
}

// Render final teams list (full lists)
function renderFinalTeamsText(sess) {
  const teamCount = sess.teams;
  const assignments = distributeAllAssignments(sess);
  const teams = Array.from({ length: teamCount }, () => ({ gk: null, players: [] }));
  const subs = [];
  for (const [id, ent] of sess.registered.entries()) {
    const asgn = assignments.get(String(id));
    if (asgn === 'sub') subs.push(ent.name);
    else {
      if (ent.role === 'gk') teams[asgn].gk = ent.name;
      else teams[asgn].players.push(ent.name);
    }
  }
  // build text
  let text = '<b>🏆 نتیجهٔ تیم‌بندی (شانسی)</b>\n\n';
  teams.forEach((t, i) => {
    text += `<b>🔹 تیم ${i+1}:</b>\n`;
    text += `🧤 ${t.gk ? escapeHtml(t.gk) : '—'}\n`;
    if (t.players.length) text += t.players.map(p => `⚽ ${escapeHtml(p)}`).join('\n') + '\n';
    text += '\n';
  });
  text += `<b>🔄 تعویضی‌ها:</b> ${subs.length ? subs.map(s => escapeHtml(s)).join(', ') : '—'}\n\n`;
  text += '📌 هر نفر فقط یک‌بار ثبت‌نام کند. 👑 فقط ادمین می‌تواند «🔀 قاطی‌کردن دوباره» را فشار دهد.';
  return text;
}

// -------------------- Handlers --------------------

// /start (private or group)
bot.onText(/^\/start(@\S+)?$/i, async (msg) => {
  try {
    if (!msg || !msg.chat) return;
    if (msg.chat.type === 'private') {
      await bot.sendMessage(msg.chat.id, 'سلام! حالت را انتخاب کن:', { reply_markup: startModeKeyboard() });
      // clear private session for safety
      privateSessions.delete(msg.chat.id);
    } else {
      // group: prompt to use /start_team (prefer admin to start)
      await bot.sendMessage(msg.chat.id, 'برای شروع تیم‌چینی دستور /start_team را ادمین گروه ارسال کند.');
    }
  } catch (e) {
    console.error('/start error', e && e.message);
  }
});

// /start_team (group) — shows team count choices
bot.onText(/^\/start_team(@\S+)?$/i, async (msg) => {
  try {
    if (!msg || !msg.chat) return;
    if (!['group','supergroup'].includes(msg.chat.type)) {
      return bot.sendMessage(msg.chat.id, 'این دستور فقط در گروه قابل اجرا است.');
    }
    // verify admin
    const member = await bot.getChatMember(msg.chat.id, msg.from.id).catch(()=>null);
    if (!member || (member.status !== 'creator' && member.status !== 'administrator')) {
      return bot.sendMessage(msg.chat.id, '⛔ فقط ادمین گروه می‌تواند تیم‌کشی را شروع کند.');
    }
    await bot.sendMessage(msg.chat.id, '🔢 تعداد تیم‌ها را انتخاب کنید:', { reply_markup: teamsKeyboard('group_') });
    // init group session framework
    groupSessions.set(msg.chat.id, {
      teams: null, registered: new Map(), statusMessageId: null, signupOpen: false
    });
  } catch (e) {
    console.error('/start_team error', e && e.message);
  }
});

// callback_query handler (all buttons)
bot.on('callback_query', async (q) => {
  if (!q || !q.data) return;
  const data = q.data;
  const msg = q.message;
  const chatId = msg.chat.id;
  const user = q.from;
  try {
    // MODE selection (private)
    if (data === 'MODE_PRIVATE') {
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(chatId, 'حالت داخل ربات انتخاب شد. لطفاً تعداد تیم‌ها را انتخاب کن:', { reply_markup: teamsKeyboard('private_') });
      privateSessions.set(chatId, { state: 'awaiting_gks', teams: null, gks: [], players: [] });
      return;
    }
    if (data === 'MODE_GROUP') {
      await bot.answerCallbackQuery(q.id);
      const me = await bot.getMe();
      const url = `https://t.me/${me.username}?startgroup=true`;
      await bot.sendMessage(chatId, `برای اضافه کردن ربات به گروه‌تان روی لینک زیر کلیک کنید:\n${url}`);
      return;
    }

    // PRIVATE team selection
    if (data && data.startsWith('private_TEAMS_')) {
      await bot.answerCallbackQuery(q.id);
      const n = Number(data.split('_')[2]);
      const sess = { state: 'awaiting_gks', teams: n, gks: [], players: [] };
      privateSessions.set(chatId, sess);
      await bot.sendMessage(chatId, `✅ تعداد تیم‌ها: ${n}\n\nابتدا نام دروازه‌بان‌ها را هر خط یک اسم بفرست (حداقل ${n} اسم).`);
      return;
    }

    // GROUP team selection
    if (data && data.startsWith('group_TEAMS_')) {
      await bot.answerCallbackQuery(q.id);
      const n = Number(data.split('_')[2]);
      // ensure group session exists
      await withLock(chatId, async () => {
        groupSessions.set(chatId, { teams: n, registered: new Map(), statusMessageId: null, signupOpen: true });
        // send initial status with keyboard
        const text = '<b>🏁 تیم‌چینی شروع شد</b>\n\nثبت‌نام با زدن دکمه‌ها انجام می‌شود. نقش خود را انتخاب کنید.';
        const sent = await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: groupSignupKeyboard() });
        const sess = groupSessions.get(chatId);
        sess.statusMessageId = sent.message_id;
      });
      return;
    }

    // GROUP join player
    if (data === 'JOIN_PLAYER' || data === 'JOIN_GK') {
      await bot.answerCallbackQuery(q.id); // respond quickly
      const sess = groupSessions.get(chatId);
      if (!sess || !sess.signupOpen) {
        return bot.answerCallbackQuery(q.id, { text: '❌ ثبت‌نام فعال نیست', show_alert: true });
      }
      // lock per chat
      await withLock(chatId, async () => {
        const uid = String(user.id);
        if (sess.registered.has(uid)) {
          return bot.answerCallbackQuery(q.id, { text: '⚠️ شما قبلاً ثبت‌نام کردید', show_alert: true });
        }
        if (data === 'JOIN_GK') {
          // limit GK
          const currentGKs = Array.from(sess.registered.values()).filter(e => e.role === 'gk').length;
          if (currentGKs >= sess.teams) return bot.answerCallbackQuery(q.id, { text: 'تعداد دروازه‌بان‌ها تکمیل شده', show_alert: true });
          sess.registered.set(uid, { id: uid, name: safeName(user), role: 'gk' });
        } else {
          sess.registered.set(uid, { id: uid, name: safeName(user), role: 'player' });
        }
        // After each registration we recompute distribution and update live message (so it's always random & balanced)
        // Use renderLiveStatusText which calls distribute copy
        const newText = renderLiveStatusText(sess);
        sess.statusMessageId = await safeEditOrSend(chatId, sess.statusMessageId, newText, groupSignupKeyboard());
        // If enough GK collected -> finalize after slight delay to let UI update
        const gkCountAfter = Array.from(sess.registered.values()).filter(e => e.role === 'gk').length;
        if (gkCountAfter === sess.teams) {
          // finalize
          setTimeout(async () => {
            await withLock(chatId, async () => {
              // recompute final and show
              const finalText = renderFinalTeamsText(sess);
              sess.statusMessageId = await safeEditOrSend(chatId, sess.statusMessageId, finalText, groupSignupKeyboard());
              sess.signupOpen = false;
            });
          }, 350);
        }
      });
      return;
    }

    // RESHUFFLE (admin only)
    if (data === 'RESHUFFLE') {
      await bot.answerCallbackQuery(q.id);
      const sess = groupSessions.get(chatId);
      if (!sess) return bot.answerCallbackQuery(q.id, { text: 'هیچ سشن فعالی نیست', show_alert: true });
      // check admin
      const member = await bot.getChatMember(chatId, user.id).catch(()=>null);
      if (!member || (member.status !== 'administrator' && member.status !== 'creator')) {
        return bot.answerCallbackQuery(q.id, { text: '⛔ فقط ادمین می‌تواند این گزینه را اجرا کند', show_alert: true });
      }
      // must have at least teams GK
      const gkCount = Array.from(sess.registered.values()).filter(e => e.role === 'gk').length;
      if (gkCount < sess.teams) {
        return bot.answerCallbackQuery(q.id, { text: `❌ تعداد دروازه‌بان‌ها کمتر از ${sess.teams} است`, show_alert: true });
      }
      // reshuffle: final distribution again
      await withLock(chatId, async () => {
        const finalText = renderFinalTeamsText(sess);
        sess.statusMessageId = await safeEditOrSend(chatId, sess.statusMessageId, finalText, groupSignupKeyboard());
      });
      await bot.answerCallbackQuery(q.id, { text: '🔀 تیم‌ها دوباره شانسی شدند' });
      return;
    }

    // default: answer to remove spinner
    await bot.answerCallbackQuery(q.id);
  } catch (err) {
    console.error('callback_query error:', err && err.message);
    try { await bot.answerCallbackQuery(q.id, { text: '❌ خطا رخ داد', show_alert: true }); } catch(e){}
  }
});

// Private message handler for name lists
bot.on('message', async (msg) => {
  if (!msg || !msg.chat) return;
  if (msg.chat.type !== 'private') return;
  try {
    const sess = privateSessions.get(msg.chat.id);
    if (!sess) return;
    if (!sess.teams) return; // safety
    if (!msg.text) return;
    if (sess.state === 'awaiting_gks') {
      // parse GK lines
      const lines = msg.text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
      sess.gks = lines.slice();
      sess.state = 'awaiting_players';
      await bot.sendMessage(msg.chat.id, `✅ دروازه‌بان‌ها دریافت شد (${sess.gks.length}). اکنون نام بازیکنان را هر خط یک اسم ارسال کن.`);
      return;
    } else if (sess.state === 'awaiting_players') {
      const lines = msg.text.split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
      sess.players = lines.slice();
      // validate GK count
      if (!sess.gks || sess.gks.length < sess.teams) {
        await bot.sendMessage(msg.chat.id, `❌ تعداد دروازه‌بان‌ها کمتر از تعداد تیم‌ها (${sess.teams}) است. لطفاً دوباره /start بزن و صحیح ارسال کن.`);
        privateSessions.delete(msg.chat.id);
        return;
      }
      // distribute
      const gkNames = shuffleArray(sess.gks).slice(0, sess.teams);
      const players = shuffleArray(sess.players);
      const teams = Array.from({length: sess.teams}, (_,i) => [ `🧤 ${gkNames[i]}` ]);
      const subs = [];
      let idx = 0;
      for (const p of players) {
        const ti = idx % sess.teams;
        if (teams[ti].length < 5) teams[ti].push(`⚽ ${p}`);
        else subs.push(p);
        idx++;
      }
      let text = '<b>🏆 نتیجهٔ داخل ربات (شانسی)</b>\n\n';
      teams.forEach((t,i)=> {
        text += `<b>🔹 تیم ${i+1}:</b>\n`;
        t.forEach(r => text += `${r}\n`);
        text += '\n';
      });
      if (subs.length) text += `<b>🔄 تعویضی‌ها:</b> ${subs.join(', ')}\n`;
      await bot.sendMessage(msg.chat.id, text, { parse_mode: 'HTML' });
      privateSessions.delete(msg.chat.id);
      return;
    }
  } catch (err) {
    console.error('private message error', err && err.message);
  }
});

// Helper: when private user clicked P_TEAMS buttons we set the private session
bot.on('callback_query', async (q) => {
  if (!q || !q.data) return;
  const data = q.data;
  const chatId = q.message.chat.id;
  try {
    if (data && data.startsWith('privateTEAMS_') === false && data.startsWith('private_TEAMS_')) {
      // handled above; nothing
    }
    if (data && data.startsWith('private_TEAMS_')) {
      const n = Number(data.split('_')[2]);
      privateSessions.set(chatId, { state: 'awaiting_gks', teams: n, gks: [], players: [] });
      await bot.answerCallbackQuery(q.id);
      await bot.sendMessage(chatId, `✅ تعداد تیم‌ها: ${n}. لطفاً ابتدا نام دروازه‌بان‌ها را هر خط یک اسم ارسال کنید.`);
    }
  } catch (err) {}
});

// Errors
bot.on('polling_error', (err) => {
  console.error('Polling error:', err && err.message);
});
console.log('✅ Ready — use /start in private and /start_team in group.');
