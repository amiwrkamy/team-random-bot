const { Telegraf, Markup } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);

// حافظه ساده برای هر گروه
const groups = {};

// ابزار
function getName(user) {
  return user.username ? `@${user.username}` : user.first_name;
}

function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

// /start
bot.start((ctx) => {
  ctx.reply(
    "🤖 به ربات تیم‌چین خوش اومدی!\n\n" +
      "این ربات برای تیم‌چینی کاملاً شانسی توی گروهه ⚽🎲\n\n" +
      "➕ اول ربات رو به گروه اضافه کن\n" +
      "👑 بعدش ادمین گروه دستور /setup رو بزنه"
  );
});

// setup فقط برای ادمین
bot.command("setup", async (ctx) => {
  if (ctx.chat.type === "private") {
    return ctx.reply("❌ این دستور فقط داخل گروهه");
  }

  const admins = await ctx.getChatAdministrators();
  const isAdmin = admins.some((a) => a.user.id === ctx.from.id);

  if (!isAdmin) {
    return ctx.reply("⛔ فقط ادمین گروه می‌تونه تیم‌چینی رو شروع کنه");
  }

  groups[ctx.chat.id] = {
    step: "choose_teams",
    teamCount: null,
    players: [],
    goalkeepers: [],
  };

  ctx.reply(
    "🧮 چند تیم می‌خوای؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("1️⃣", "TEAM_1")],
      [Markup.button.callback("2️⃣", "TEAM_2")],
      [Markup.button.callback("3️⃣", "TEAM_3")],
      [Markup.button.callback("4️⃣", "TEAM_4")],
    ])
  );
});

// انتخاب تعداد تیم
bot.action(/TEAM_(\d)/, (ctx) => {
  const teamCount = Number(ctx.match[1]);
  const group = groups[ctx.chat.id];
  if (!group) return;

  group.teamCount = teamCount;
  group.step = "register";

  ctx.editMessageText(
    `🏆 تیم‌چینی شروع شد!\n` +
      `تعداد تیم‌ها: ${teamCount}\n\n` +
      `نقش خودتو انتخاب کن 👇`,
    Markup.inlineKeyboard([
      [Markup.button.callback("⚽ بازیکن", "JOIN_PLAYER")],
      [Markup.button.callback("🧤 دروازه‌بان", "JOIN_GK")],
    ])
  );
});

// ثبت بازیکن
bot.action("JOIN_PLAYER", (ctx) => {
  const group = groups[ctx.chat.id];
  if (!group) return;

  const name = getName(ctx.from);

  if (
    group.players.includes(name) ||
    group.goalkeepers.includes(name)
  ) {
    return ctx.answerCbQuery("❗ قبلاً ثبت شدی");
  }

  group.players.push(name);
  ctx.answerCbQuery("✅ به‌عنوان بازیکن ثبت شدی");
  updateTeams(ctx);
});

// ثبت دروازه‌بان
bot.action("JOIN_GK", (ctx) => {
  const group = groups[ctx.chat.id];
  if (!group) return;

  const name = getName(ctx.from);

  if (group.goalkeepers.length >= group.teamCount) {
    return ctx.answerCbQuery("⛔ همه تیم‌ها دروازه‌بان دارن");
  }

  if (
    group.players.includes(name) ||
    group.goalkeepers.includes(name)
  ) {
    return ctx.answerCbQuery("❗ قبلاً ثبت شدی");
  }

  group.goalkeepers.push(name);
  ctx.answerCbQuery("🧤 به‌عنوان دروازه‌بان ثبت شدی");
  updateTeams(ctx);
});

// نمایش تیم‌ها
function updateTeams(ctx) {
  const group = groups[ctx.chat.id];
  if (!group) return;

  const teams = Array.from({ length: group.teamCount }, () => ({
    gk: null,
    players: [],
    subs: [],
  }));

  shuffle(group.goalkeepers).forEach((gk, i) => {
    teams[i].gk = gk;
  });

  shuffle(group.players).forEach((p, i) => {
    const teamIndex = i % group.teamCount;
    if (teams[teamIndex].players.length < 4) {
      teams[teamIndex].players.push(p);
    } else {
      teams[teamIndex].subs.push(p);
    }
  });

  let text = "🏆 وضعیت تیم‌ها:\n\n";

  teams.forEach((t, i) => {
    text += `🔹 تیم ${i + 1}\n`;
    text += `🧤 ${t.gk || "—"}\n`;
    t.players.forEach((p) => (text += `⚽ ${p}\n`));
    t.subs.forEach((s) => (text += `🔄 ${s}\n`));
    text += "\n";
  });

  ctx.editMessageText(
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback("⚽ بازیکن", "JOIN_PLAYER")],
      [Markup.button.callback("🧤 دروازه‌بان", "JOIN_GK")],
    ])
  );
}

// اجرا
bot.launch();
console.log("🤖 Bot is running...");
