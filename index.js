// index.js
'use strict';

const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const Redis = require('ioredis');
const fetch = require('node-fetch');

const BOT_TOKEN = process.env.BOT_TOKEN;
const REDIS_URL = process.env.REDIS_URL; // e.g. redis://:password@host:port
const USE_WEBHOOK = (process.env.USE_WEBHOOK || 'true').toLowerCase() === 'true';
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://your-service.onrender.com/telegram-webhook
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error('Missing BOT_TOKEN env var');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// Redis client (simple)
let redis;
if (REDIS_URL) {
  redis = new Redis(REDIS_URL);
} else {
  console.warn('No REDIS_URL provided — sessions will be ephemeral (not recommended). Using in-memory fallback.');
  // In-memory fallback (not persistent)
  const mem = new Map();
  redis = {
    async get(k) { const v = mem.get(k); return v === undefined ? null : v; },
    async set(k, v) { mem.set(k, v); return 'OK'; },
    async del(k) { mem.delete(k); return 1; }
  };
}

// Utility: session key
const sessionKey = (chatId) => `session:${chatId}`;

// Helper: read session
async function loadSession(chatId) {
  const raw = await redis.get(sessionKey(chatId));
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed parse session', e);
    return null;
  }
}

// Helper: save session
async function saveSession(chatId, sess) {
  await redis.set(sessionKey(chatId), JSON.stringify(sess));
}

// Helper: create new group session skeleton
function createEmptyGroupSession(teamsCount) {
  return {
    type: 'group',
    teamsCount: teamsCount,
    teams: Array.from({length: teamsCount}, () => []), // arrays of {id,name,role}
    membersMap: {}, // userId -> true
    signupOpen: true,
    message_id: null, // message to edit
    creator: null // user id who started
  };
}

// Utility: shuffle array
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; --i) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Build inline keyboard for group session
function buildGroupKeyboard() {
  return Markup.inlineKeyboard([
    [ Markup.button.callback('⚽ بازیکن', 'join:player'), Markup.button.callback('🥅 دروازه‌بان', 'join:gk') ],
    [ Markup.button.callback('🔀 قاطی‌کردن دوباره (فقط ادمین)', 'action:reshuffle') ]
  ]);
}

// Build status text for teams (nicely formatted)
function buildTeamsText(sess) {
  let text = '🏆 وضعیت تیم‌ها (لایو)\n\n';
  for (let i = 0; i < sess.teamsCount; ++i) {
    const t = sess.teams[i];
    text += `🔵 تیم ${i+1} — ${t.length} نفر\n`;
    if (t.length) {
      for (const p of t) {
        const icon = p.role === 'gk' ? '🧤' : '⚽';
        text += ` ${icon} ${escapeMarkdown(p.name)}\n`;
      }
    } else text += ' —\n';
    text += '\n';
  }
  // substitutes: any members beyond 5 in a team should become substitutes — but we maintain that invariant on insert
  const subs = [];
  for (let i=0;i<sess.teamsCount;i++) {
    // none here because insertion logic prevents >5
  }
  text += '🔄 تعویضی‌ها: —\n\n';
  text += '📌 هر نفر فقط یک‌بار می‌تواند ثبت‌نام کند.\n';
  text += '👑 فقط ادمین می‌تواند «🔀 قاطی‌کردن دوباره» را اجرا کند.';
  return text;
}

function escapeMarkdown(s) {
  if (!s) return '';
  // Escape basic markdown chars for safe edit
  return s.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// Assign player into a team (random with balancing)
function assignPlayerToTeam(sess, userId, name) {
  // Build array of eligible teams (len < 5)
  const eligible = [];
  let minLen = Infinity;
  for (let i = 0; i < sess.teamsCount; ++i) {
    const len = sess.teams[i].length;
    if (len < 5) {
      if (len < minLen) {
        minLen = len;
      }
    }
  }
  for (let i = 0; i < sess.teamsCount; ++i) {
    if (sess.teams[i].length === minLen && sess.teams[i].length < 5) eligible.push(i);
  }
  if (eligible.length === 0) return null;
  const chosen = eligible[Math.floor(Math.random() * eligible.length)];
  sess.teams[chosen].push({ id: userId, name: name, role: 'player' });
  sess.membersMap[userId] = true;
  return chosen;
}

// Assign GK into a team (random among teams without GK)
function assignGkToTeam(sess, userId, name) {
  const withoutGk = [];
  for (let i = 0; i < sess.teamsCount; ++i) {
    const hasGK = sess.teams[i].some(p => p.role === 'gk');
    if (!hasGK && sess.teams[i].length < 5) withoutGk.push(i);
  }
  if (withoutGk.length === 0) return null;
  const chosen = withoutGk[Math.floor(Math.random() * withoutGk.length)];
  sess.teams[chosen].push({ id: userId, name: name, role: 'gk' });
  sess.membersMap[userId] = true;
  return chosen;
}

// Re-shuffle session: take all members, separate GK and players, then randomly assign respecting rules
function reshuffleSession(sess) {
  // gather gks and players
  const gks = [];
  const players = [];
  for (let i = 0; i < sess.teamsCount; ++i) {
    for (const p of sess.teams[i]) {
      if (p.role === 'gk') gks.push({id: p.id, name: p.name});
      else players.push({id: p.id, name: p.name});
    }
  }
  // Must have exactly <= teamsCount gks (we only allow adding GK up to teamsCount)
  // If not enough gks — reshuffle cannot create new GK — so keep current distribution and return false if fail
  if (gks.length < sess.teamsCount) {
    // can't reshuffle because not enough GK
    return { ok: false, reason: 'not_enough_gk' };
  }
  // shuffle arrays
  shuffle(gks);
  shuffle(players);
  // reset teams
  sess.teams = Array.from({length: sess.teamsCount}, () => []);
  // place one GK per team
  for (let i=0;i<sess.teamsCount;i++) {
    sess.teams[i].push({ id: gks[i].id, name: gks[i].name, role: 'gk' });
  }
  // place players round-robin but keep max 5 per team (incl gk), extras go to substitutes list (we'll keep them but they will be assigned to subs)
  const extras = [];
  let idx = 0;
  for (const pl of players) {
    const teamIdx = idx % sess.teamsCount;
    if (sess.teams[teamIdx].length < 5) {
      sess.teams[teamIdx].push({ id: pl.id, name: pl.name, role: 'player' });
    } else {
      extras.push(pl);
    }
    idx++;
  }
  // extras: we'll append to 'subs' or leave as extras (here we append to a dedicated extras list inside session)
  sess.extras = extras;
  return { ok: true };
}

// Update (edit) status message in group; if fails, send new message and save its id
async function updateGroupStatusMessage(ctxBot, chatId, sess) {
  const text = buildTeamsText(sess);
  const keyboard = buildGroupKeyboard();
  try {
    if (sess.message_id) {
      await ctxBot.telegram.editMessageText(chatId, sess.message_id, null, text, { parse_mode: 'MarkdownV2', ...keyboard });
    } else {
      const sent = await ctxBot.telegram.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', ...keyboard });
      sess.message_id = sent.message_id;
    }
  } catch (err) {
    console.error('Failed to edit message, sending new', err?.message || err);
    const sent = await ctxBot.telegram.sendMessage(chatId, text, { parse_mode: 'MarkdownV2', ...keyboard });
    sess.message_id = sent.message_id;
  }
}


// --- Bot commands & handlers --- //

// /start in private or group
bot.start(async (ctx) => {
  const chat = ctx.chat;
  if (chat.type === 'private') {
    // show mode: inside bot or inside group
    return ctx.reply('سلام! لطفاً انتخاب کن که می‌خوای تیم‌چینی داخل ربات باشه یا داخل گروه؟', Markup.inlineKeyboard([
      [ Markup.button.callback('🤖 داخل ربات', 'mode:inside_bot') ],
      [ Markup.button.callback('👥 داخل گروه', 'mode:inside_group') ]
    ]));
  } else {
    // group: instruct to run /start_team (only admin should start)
    return ctx.reply('برای شروع تیم‌چینی در گروه، ادمین دستور /start_team را اجرا کند.');
  }
});

// /start_team command (group) — admin triggers
bot.command('start_team', async (ctx) => {
  const chat = ctx.chat;
  if (chat.type === 'private') return ctx.reply('این دستور فقط در گروه اجرا می‌شود.');
  // check admin
  try {
    const admins = await ctx.getChatAdministrators();
    const isAdmin = admins.some(a => a.user.id === ctx.from.id);
    if (!isAdmin) return ctx.reply('فقط ادمین گروه می‌تواند تیم‌چینی را آغاز کند.');
  } catch (e) {
    console.error('admin check failed', e);
  }
  // ask number of teams
  await ctx.reply('🔢 چند تیم می‌خواهی؟', Markup.inlineKeyboard([
    [ Markup.button.callback('2️⃣  2 تیم', 'teams:2') ],
    [ Markup.button.callback('3️⃣  3 تیم', 'teams:3') ],
    [ Markup.button.callback('4️⃣  4 تیم', 'teams:4') ]
  ]));
});

// Callback query handler
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chat = ctx.chat || (ctx.callbackQuery.message && ctx.callbackQuery.message.chat);
  const from = ctx.from;
  try {
    // Mode selection from private
    if (data === 'mode:inside_bot') {
      await ctx.answerCbQuery();
      return ctx.reply('در حالت داخل ربات، بعد از انتخاب تعداد تیم‌ها، نام‌ها را مستقیم در همین چت خصوصی بفرست.\n\n🔢 چند تیم می‌خواهی؟', Markup.inlineKeyboard([
        [ Markup.button.callback('2️⃣  2 تیم', 'private:teams:2') ],
        [ Markup.button.callback('3️⃣  3 تیم', 'private:teams:3') ],
        [ Markup.button.callback('4️⃣  4 تیم', 'private:teams:4') ]
      ]));
    }

    if (data === 'mode:inside_group') {
      await ctx.answerCbQuery();
      const botUser = (await bot.telegram.getMe()).username;
      const addUrl = `https://t.me/${botUser}?startgroup=true`;
      return ctx.replyWithHTML('برای اضافه کردن ربات به گروه خود، از لینک زیر استفاده کنید:\n' + `<a href="${addUrl}">اضافه کردن ربات به گروه</a>`);
    }

    // private teams selection (after mode inside bot)
    if (data && data.startsWith('private:teams:')) {
      await ctx.answerCbQuery();
      const num = Number(data.split(':').pop());
      // create a private session expecting names
      const sess = { type: 'private', teamsCount: num, awaitingNames: true, creator: from.id };
      await saveSession(chat.id, sess);
      return ctx.reply(`💡 لطفاً اسامی را در همین چت خصوصی ارسال کن.\n\nقواعد:\n- ابتدا دروازه‌بان‌ها (هر دروازه‌بان را در یک خط و با پیش‌نویس GK: یا فقط نام بنویس)\n- سپس یک خط خالی و بعد بازیکن‌ها (هر نام در یک خط)\n\nمثال:\nGK: Ali\nGK: Hassan\n\nSara\nReza\nMina\n...`);
    }

    // group teams selection
    if (data && data.startsWith('teams:')) {
      await ctx.answerCbQuery();
      const num = Number(data.split(':').pop());
      // group chat
      const chatId = chat.id;
      const sess = createEmptyGroupSession(num);
      sess.creator = from.id;
      await saveSession(chatId, sess);
      // send initial status message with keyboard
      await updateGroupStatusMessage(bot, chatId, sess);
      await saveSession(chatId, sess);
      return;
    }

    // Join player
    if (data === 'join:player') {
      await ctx.answerCbQuery();
      const chatId = chat.id;
      const sess = await loadSession(chatId);
      if (!sess || !sess.signupOpen) return ctx.answerCbQuery('🔒 ثبت‌نام فعالی وجود ندارد.', { show_alert: true });
      if (sess.membersMap && sess.membersMap[from.id]) return ctx.answerCbQuery('شما قبلاً ثبت‌نام کرده‌اید.', { show_alert: true });
      // assign player
      const name = from.username ? `@${from.username}` : (from.first_name || 'کاربر');
      const teamIdx = assignPlayerToTeam(sess, from.id, name);
      if (teamIdx === null) {
        // all teams full
        return ctx.answerCbQuery('همهٔ تیم‌ها پر هستند — شما در لیست تعویضی قرار می‌گیرید.', { show_alert: true });
      }
      await saveSession(chatId, sess);
      await updateGroupStatusMessage(bot, chatId, sess);
      return ctx.answerCbQuery('✅ شما به عنوان بازیکن ثبت شدید.');
    }

    // Join GK
    if (data === 'join:gk') {
      await ctx.answerCbQuery();
      const chatId = chat.id;
      const sess = await loadSession(chatId);
      if (!sess || !sess.signupOpen) return ctx.answerCbQuery('🔒 ثبت‌نام فعالی وجود ندارد.', { show_alert: true });
      if (sess.membersMap && sess.membersMap[from.id]) return ctx.answerCbQuery('شما قبلاً ثبت‌نام کرده‌اید.', { show_alert: true });
      const name = from.username ? `@${from.username}` : (from.first_name || 'کاربر');
      const teamIdx = assignGkToTeam(sess, from.id, name);
      if (teamIdx === null) {
        return ctx.answerCbQuery('تعداد دروازه‌بان‌ها تکمیل شده یا تیم مناسب پیدا نشد.', { show_alert: true });
      }
      await saveSession(chatId, sess);
      await updateGroupStatusMessage(bot, chatId, sess);
      return ctx.answerCbQuery(`✅ شما به عنوان دروازه‌بان در تیم ${teamIdx+1} ثبت شدید.`);
    }

    // Reshuffle (admin only)
    if (data === 'action:reshuffle') {
      // check admin
      const chatId = chat.id;
      const sess = await loadSession(chatId);
      const admins = await bot.telegram.getChatAdministrators(chatId);
      const isAdmin = admins.some(a => a.user.id === from.id);
      if (!isAdmin) {
        return ctx.answerCbQuery('⚠️ فقط ادمین می‌تواند این کار را انجام دهد.', { show_alert: true });
      }
      // reshuffle
      const res = reshuffleSession(sess);
      if (!res.ok) {
        await saveSession(chatId, sess);
        await updateGroupStatusMessage(bot, chatId, sess);
        return ctx.answerCbQuery('⚠️ قاطی‌کردن دوباره ممکن نیست — تعداد دروازه‌بان‌ها کافی نیست.', { show_alert: true });
      }
      await saveSession(chatId, sess);
      await updateGroupStatusMessage(bot, chatId, sess);
      return ctx.answerCbQuery('🔀 بازچینش انجام شد.');
    }

    // fallback
    await ctx.answerCbQuery();
  } catch (err) {
    console.error('callback error', err);
    try { await ctx.answerCbQuery('خطا رخ داد. دوباره تلاش کنید.', { show_alert: true }); } catch(e){}
  }
});

// Private chat text handler (names parsing)
bot.on('message', async (ctx) => {
  try {
    const chat = ctx.chat;
    if (chat.type !== 'private') return; // we handle only private typing for names here
    const sess = await loadSession(chat.id);
    if (!sess || sess.type !== 'private' || !sess.awaitingNames) return;
    const text = ctx.message.text || '';
    // parse: GK lines optionally start with GK: or just lines before empty line
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length === 0) return ctx.reply('لطفاً اسامی را ارسال کنید (هر نام در یک خط).');
    // We'll accept format where lines starting with GK: are GKs, else we split by blank line but simpler:
    const gkNames = [];
    const playerNames = [];
    let mode = 'gk'; // until we see a line "---" or "players:"
    for (const L of lines) {
      if (/^players?:/i.test(L) || /^بازیکن/i.test(L)) { mode = 'players'; continue; }
      if (/^gk[:\-]?/i.test(L) || /^دروازه/i.test(L)) {
        // allow 'GK: Name'
        const name = L.replace(/^gk[:\-]?\s*/i,'').trim();
        if (name) gkNames.push(name);
        else mode='players';
        continue;
      }
      // If we encounter an empty line (we filtered empties), so treat first non-GK after some is player
      if (mode === 'gk' && gkNames.length>0 && !/^gk[:\-]?/i.test(L)) {
        mode = 'players';
      }
      if (mode === 'gk') gkNames.push(L);
      else playerNames.push(L);
    }
    // require gkNames length >= teamsCount
    if (gkNames.length < sess.teamsCount) {
      return ctx.reply(`❌ تعداد دروازه‌بان‌ها باید حداقل برابر تعداد تیم‌ها (${sess.teamsCount}) باشد. دروازه‌بان‌ها: ${gkNames.length}`);
    }
    // now distribute randomly
    shuffle(gkNames);
    shuffle(playerNames);
    // prepare teams
    const teams = [];
    for (let i=0;i<sess.teamsCount;i++) teams.push([]);
    // put GK one per team
    for (let i=0;i<sess.teamsCount;i++) {
      teams[i].push({ id: null, name: gkNames[i], role: 'gk' });
    }
    // place players round-robin with max 5 per team (including GK)
    let idx = 0;
    const extras = [];
    for (const pname of playerNames) {
      const t = idx % sess.teamsCount;
      if (teams[t].length < 5) {
        teams[t].push({ id: null, name: pname, role: 'player' });
      } else {
        extras.push(pname);
      }
      idx++;
    }
    // Build message text
    let textOut = '🏆 نتایج تیم‌چینی:\n\n';
    for (let i=0;i<teams.length;i++) {
      textOut += `🔵 تیم ${i+1}:\n`;
      for (const p of teams[i]) {
        const icon = (p.role === 'gk') ? '🧤' : '⚽';
        textOut += ` ${icon} ${escapeMarkdown(p.name)}\n`;
      }
      textOut += '\n';
    }
    if (extras.length) {
      textOut += '🔄 بازیکنان ذخیره: ' + extras.map(e=>escapeMarkdown(e)).join(', ') + '\n';
    }
    await ctx.reply(textOut, { parse_mode: 'MarkdownV2' });
    // mark session ended
    sess.awaitingNames = false;
    await saveSession(chat.id, sess);

  } catch (err) {
    console.error('private message handler error', err);
  }
});

// health endpoint + webhook express if needed
if (USE_WEBHOOK && WEBHOOK_URL) {
  const app = express();
  app.use(express.json());
  app.get('/healthz', (req, res) => res.send('OK'));
  app.post('/telegram-webhook', (req, res, next) => {
    try {
      bot.handleUpdate(req.body, res).then(() => res.status(200).end()).catch(next);
    } catch (e) {
      next(e);
    }
  });

  // start express
  app.listen(PORT, async () => {
    console.log('Express webhook server listening on', PORT);
    // set webhook
    try {
      const setRes = await bot.telegram.setWebhook(`${WEBHOOK_URL}`);
      console.log('Webhook set result:', setRes);
    } catch (e) {
      console.error('Failed to set webhook:', e);
    }
  });
} else {
  // Polling mode
  (async () => {
    try {
      // ensure webhook removed to avoid 409
      try {
        await bot.telegram.deleteWebhook();
        console.log('Deleted webhook (if existed).');
      } catch (e) {
        // ignore
      }
      await bot.launch();
      console.log('Bot started (polling) ✅');
    } catch (err) {
      console.error('Bot launch error', err);
    }
  })();
}

// global error handling
process.on('uncaughtException', (err) => {
  console.error('uncaughtException', err);
  // optionally send admin alert here
  // then exit to let host restart
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection', reason);
});

// export for testing (if needed)
module.exports = { bot, redis };
