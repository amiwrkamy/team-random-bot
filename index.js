const { Telegraf, Markup } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);

// ====== حافظه ساده ======
const sessions = {}; // key = chatId

function getName(user) {
  return user.username ? `@${user.username}` : user.first_name;
}

function initSession(chatId) {
  sessions[chatId] = {
    mode: null, // "bot" | "group"
    teamCount: 2,
    players: [],
    teams: []
  };
}

// ====== START ======
bot.start((ctx) => {
  initSession(ctx.chat.id);
  ctx.reply(
    "🏟 تیم‌چینی کجا انجام بشه؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("👤 داخل ربات", "MODE_BOT")],
      [Markup.button.callback("👥 داخل گروه", "MODE_GROUP")]
    ])
  );
});

// ====== MODE ======
bot.action("MODE_BOT", async (ctx) => {
  await ctx.answerCbQuery();
  sessions[ctx.chat.id].mode = "bot";
  ctx.reply(
    "🧮 چند تیم می‌خوای؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("🔵 ۲ تیم", "BOT_2")],
      [Markup.button.callback("🟢 ۳ تیم", "BOT_3")]
    ])
  );
});

bot.action("MODE_GROUP", async (ctx) => {
  await ctx.answerCbQuery();
  sessions[ctx.chat.id].mode = "group";
  ctx.reply(
    "🧮 چند تیم می‌خوای؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("🔵 ۲ تیم", "GROUP_2")],
      [Markup.button.callback("🟢 ۳ تیم", "GROUP_3")]
    ])
  );
});

// ====== BOT MODE ======
bot.action(["BOT_2", "BOT_3"], async (ctx) => {
  await ctx.answerCbQuery();
  const count = ctx.callbackQuery.data === "BOT_2" ? 2 : 3;
  sessions[ctx.chat.id].teamCount = count;
  ctx.reply("✍️ اسم بازیکن‌ها رو با فاصله بفرست");
});

bot.on("text", (ctx) => {
  const s = sessions[ctx.chat.id];
  if (!s || s.mode !== "bot") return;

  const names = ctx.message.text.split(" ").filter(Boolean);
  const shuffled = names.sort(() => Math.random() - 0.5);

  const teams = Array.from({ length: s.teamCount }, () => []);
  shuffled.forEach((p, i) => teams[i % s.teamCount].push(p));

  let msg = "🏆 نتیجه تیم‌ها:\n\n";
  teams.forEach((t, i) => {
    msg += `🔥 تیم ${i + 1}:\n`;
    t.forEach(n => msg += `⚽ ${n}\n`);
    msg += "\n";
  });

  ctx.reply(msg);
  initSession(ctx.chat.id);
});

// ====== GROUP MODE ======
bot.action(["GROUP_2", "GROUP_3"], async (ctx) => {
  await ctx.answerCbQuery();
  const count = ctx.callbackQuery.data === "GROUP_2" ? 2 : 3;
  const chatId = ctx.chat.id;

  sessions[chatId].teamCount = count;
  sessions[chatId].teams = Array.from({ length: count }, () => []);

  ctx.reply(
    "🏆 تیم‌چینی شروع شد!\nنقش خودتو انتخاب کن 👇",
    Markup.inlineKeyboard([
      [Markup.button.callback("⚽ بازیکن", "JOIN_PLAYER")],
      [Markup.button.callback("🧤 دروازه‌بان", "JOIN_GK")]
    ])
  );
});

bot.action(["JOIN_PLAYER", "JOIN_GK"], async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const s = sessions[chatId];
  if (!s) return;

  const name = getName(ctx.from);
  if (s.players.includes(name)) return;

  s.players.push(name);
  const teamIndex = Math.floor(Math.random() * s.teamCount);
  s.teams[teamIndex].push(name);

  let msg = "🏆 وضعیت تیم‌ها:\n\n";
  s.teams.forEach((t, i) => {
    msg += `🔥 تیم ${i + 1}:\n`;
    t.forEach(n => msg += `⚽ ${n}\n`);
    msg += "\n";
  });

  ctx.editMessageText(
    msg,
    Markup.inlineKeyboard([
      [Markup.button.callback("⚽ بازیکن", "JOIN_PLAYER")],
      [Markup.button.callback("🧤 دروازه‌بان", "JOIN_GK")]
    ])
  );
});

// ====== RUN ======
bot.launch();
console.log("🤖 Team bot running");
