const { Telegraf, Markup } = require("telegraf");

const bot = new Telegraf(process.env.BOT_TOKEN || "TOKEN_BOT");

const sessions = {}; // وضعیت هر چت

// ---------- START ----------
bot.start((ctx) => {
  sessions[ctx.chat.id] = {};
  ctx.reply(
    "⚽ تیم‌کِشی فوتبال\n\nروش رو انتخاب کن:",
    Markup.inlineKeyboard([
      [Markup.button.callback("🤖 داخل ربات", "MODE_BOT")],
      [Markup.button.callback("👥 داخل گروه", "MODE_GROUP")]
    ])
  );
});

// ---------- MODE BOT ----------
bot.action("MODE_BOT", (ctx) => {
  sessions[ctx.chat.id] = { mode: "bot" };
  ctx.editMessageText(
    "🔢 چند تیم می‌خوای؟",
    Markup.inlineKeyboard([
      [Markup.button.callback("2️⃣ دو تیم", "BOT_TEAM_2")],
      [Markup.button.callback("3️⃣ سه تیم", "BOT_TEAM_3")],
      [Markup.button.callback("4️⃣ چهار تیم", "BOT_TEAM_4")]
    ])
  );
});

// ---------- MODE GROUP ----------
bot.action("MODE_GROUP", (ctx) => {
  const botUsername = ctx.me;
  ctx.editMessageText(
    "👥 ربات رو به گروه اضافه کن:",
    Markup.inlineKeyboard([
      [
        Markup.button.url(
          "➕ افزودن به گروه",
          `https://t.me/${botUsername}?startgroup=true`
        )
      ]
    ])
  );
});

// ---------- BOT TEAM COUNT ----------
["2", "3", "4"].forEach((n) => {
  bot.action(`BOT_TEAM_${n}`, (ctx) => {
    sessions[ctx.chat.id].teamCount = Number(n);
    sessions[ctx.chat.id].step = "names";
    ctx.editMessageText(
      "✍️ اسم‌ها رو بفرست (هر خط یک نفر)\n\n📌 به تعداد تیم‌ها اولی‌ها دروازه‌بان می‌شن"
    );
  });
});

// ---------- RECEIVE NAMES (BOT MODE) ----------
bot.on("text", (ctx) => {
  const s = sessions[ctx.chat.id];
  if (!s || s.mode !== "bot" || s.step !== "names") return;

  const names = ctx.message.text
    .split("\n")
    .map((n) => n.trim())
    .filter(Boolean);

  if (names.length < s.teamCount) {
    return ctx.reply("❌ تعداد اسم‌ها کمتر از تعداد تیم‌هاست");
  }

  const keepers = names.slice(0, s.teamCount);
  const players = shuffle(names.slice(s.teamCount));

  const teams = Array.from({ length: s.teamCount }, (_, i) => ({
    name: `🔵 تیم ${i + 1}`,
    gk: keepers[i],
    players: [],
    subs: []
  }));

  for (const p of players) {
    const team = teams.reduce((a, b) =>
      a.players.length < b.players.length ? a : b
    );

    if (team.players.length < 4) {
      team.players.push(p);
    } else {
      team.subs.push(p);
    }
  }

  let result = "🏆 نتیجه تیم‌کِشی:\n\n";
  teams.forEach((t) => {
    result += `${t.name}\n`;
    result += `🧤 دروازه‌بان: ${t.gk}\n`;
    result += `👟 بازیکن‌ها: ${t.players.join("، ") || "—"}\n`;
    result += `🔄 تعویضی‌ها: ${t.subs.join("، ") || "—"}\n\n`;
  });

  ctx.reply(result);
  delete sessions[ctx.chat.id];
});

// ---------- UTILS ----------
function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

// ---------- SAFE ----------
bot.catch(() => {});
bot.launch();
