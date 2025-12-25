const { Telegraf, Markup } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN);

// ذخیره وضعیت گروه‌ها
const groups = {};

// استارت
bot.start((ctx) => {
  ctx.reply(
    "🎲 تیم‌کِشی شانسی\n\nانتخاب کن:",
    Markup.inlineKeyboard([
      [Markup.button.callback("👤 داخل ربات", "IN_PRIVATE")],
      [Markup.button.callback("👥 داخل گروه", "IN_GROUP")]
    ])
  );
});

// داخل ربات
bot.action("IN_PRIVATE", (ctx) => {
  ctx.editMessageText(
    "چند تیم می‌خوای؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("2️⃣ تیم", "P_2")],
      [Markup.button.callback("3️⃣ تیم", "P_3")],
      [Markup.button.callback("4️⃣ تیم", "P_4")]
    ])
  );
});

// داخل گروه
bot.action("IN_GROUP", (ctx) => {
  ctx.editMessageText(
    "ربات رو به گروه اضافه کن 👇",
    Markup.inlineKeyboard([
      [
        Markup.button.url(
          "➕ افزودن به گروه",
          `https://t.me/${ctx.botInfo.username}?startgroup=true`
        )
      ]
    ])
  );
});

// انتخاب تعداد تیم در گروه
bot.on("new_chat_members", (ctx) => {
  if (ctx.message.new_chat_members.some(u => u.id === ctx.botInfo.id)) {
    groups[ctx.chat.id] = {
      players: [],
      goalkeepers: [],
      teamCount: 0
    };

    ctx.reply(
      "چند تیم می‌خواید؟",
      Markup.inlineKeyboard([
        [Markup.button.callback("2️⃣ تیم", "G_2")],
        [Markup.button.callback("3️⃣ تیم", "G_3")],
        [Markup.button.callback("4️⃣ تیم", "G_4")]
      ])
    );
  }
});

// ثبت تعداد تیم
["2","3","4"].forEach(n => {
  bot.action(`G_${n}`, (ctx) => {
    const chatId = ctx.chat.id;
    groups[chatId].teamCount = Number(n);

    ctx.editMessageText(
      "ثبت‌نام شروع شد 👇\nهر نفر فقط یک بار",
      Markup.inlineKeyboard([
        [Markup.button.callback("🏃‍♂️ بازیکن", "PLAYER")],
        [Markup.button.callback("🧤 دروازه‌بان", "GK")],
        [Markup.button.callback("🎲 قرعه‌کشی (ادمین)", "DRAW")]
      ])
    );
  });
});

// ثبت بازیکن
bot.action("PLAYER", (ctx) => {
  const g = groups[ctx.chat.id];
  if (!g) return;

  if (
    g.players.find(p => p.id === ctx.from.id) ||
    g.goalkeepers.find(p => p.id === ctx.from.id)
  ) {
    return ctx.answerCbQuery("❌ قبلاً ثبت شدی");
  }

  g.players.push({ id: ctx.from.id, name: ctx.from.first_name });
  ctx.answerCbQuery("✅ بازیکن ثبت شد");
});

// ثبت دروازه‌بان
bot.action("GK", (ctx) => {
  const g = groups[ctx.chat.id];
  if (!g) return;

  if (g.goalkeepers.length >= g.teamCount) {
    return ctx.answerCbQuery("❌ دروازه‌بان تکمیل شده");
  }

  if (
    g.players.find(p => p.id === ctx.from.id) ||
    g.goalkeepers.find(p => p.id === ctx.from.id)
  ) {
    return ctx.answerCbQuery("❌ قبلاً ثبت شدی");
  }

  g.goalkeepers.push({ id: ctx.from.id, name: ctx.from.first_name });
  ctx.answerCbQuery("🧤 دروازه‌بان ثبت شد");
});

// قرعه‌کشی
bot.action("DRAW", (ctx) => {
  if (!ctx.chat.type.includes("group")) return;

  const g = groups[ctx.chat.id];
  if (!g) return;

  if (g.goalkeepers.length < g.teamCount) {
    return ctx.answerCbQuery("❌ هر تیم باید یک دروازه‌بان داشته باشد");
  }

  const shuffle = (arr) => arr.sort(() => Math.random() - 0.5);

  const teams = Array.from({ length: g.teamCount }, (_, i) => ({
    name: `🏟 تیم ${i + 1}`,
    gk: g.goalkeepers[i],
    players: []
  }));

  shuffle(g.players);

  let i = 0;
  for (const p of g.players) {
    if (teams[i].players.length < 4) {
      teams[i].players.push(p);
    }
    i = (i + 1) % teams.length;
  }

  let text = "🎯 نتیجه قرعه‌کشی:\n\n";
  teams.forEach(t => {
    text += `${t.name}\n`;
    text += `🧤 ${t.gk.name}\n`;
    t.players.forEach(p => {
      text += `⚽ ${p.name}\n`;
    });
    text += "\n";
  });

  ctx.reply(text);
});

bot.launch();
