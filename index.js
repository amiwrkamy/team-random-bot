import express from "express";
import TelegramBot from "node-telegram-bot-api";

/* ================== CONFIG ================== */
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) throw new Error("BOT_TOKEN missing");

/* ================== FAKE SERVER (Render) ================== */
const app = express();
const PORT = process.env.PORT || 3000;
app.get("/", (_, res) => res.send("OK"));
app.listen(PORT);

/* ================== BOT ================== */
const bot = new TelegramBot(TOKEN, { polling: true });

/* ================== STATE ================== */
const sessions = {}; 
// chatId => { teams, players[], goalkeepers[], locked }

/* ================== HELPERS ================== */
function shuffle(arr) {
  return arr.sort(() => Math.random() - 0.5);
}

/* ================== START ================== */
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "⚽ انتخاب کن:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🤖 داخل ربات", callback_data: "IN_BOT" }],
        [{ text: "👥 داخل گروه", callback_data: "IN_GROUP" }],
      ],
    },
  });
});

/* ================== CALLBACKS ================== */
bot.on("callback_query", async (q) => {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const data = q.data;
  await bot.answerCallbackQuery(q.id);

  if (data === "IN_BOT") {
    sessions[chatId] = { step: "BOT_TEAMS" };
    return bot.sendMessage(chatId, "🔢 چند تیم؟", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "2️⃣", callback_data: "BOT_2" }],
          [{ text: "3️⃣", callback_data: "BOT_3" }],
          [{ text: "4️⃣", callback_data: "BOT_4" }],
        ],
      },
    });
  }

  if (data.startsWith("BOT_")) {
    sessions[chatId].teams = Number(data.split("_")[1]);
    sessions[chatId].players = [];
    sessions[chatId].goalkeepers = [];
    sessions[chatId].step = "NAMES";
    return bot.sendMessage(
      chatId,
      "✍️ اسم‌ها رو بفرست\nهر خط: `اسم - بازیکن / دروازه‌بان`",
      { parse_mode: "Markdown" }
    );
  }

  if (data === "IN_GROUP") {
    return bot.sendMessage(
      chatId,
      "👥 ربات رو به گروه اضافه کن و ادمینش کن\nبعد /start بزن داخل گروه"
    );
  }

  if (data === "REDRAW") {
    if (q.from.id !== q.message.chat.id) return;
    drawTeams(chatId);
  }
});

/* ================== TEXT HANDLER ================== */
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  if (!sessions[chatId] || sessions[chatId].step !== "NAMES") return;
  if (!msg.text) return;

  msg.text.split("\n").forEach((line) => {
    const [name, role] = line.split("-");
    if (!name || !role) return;
    if (role.includes("دروازه")) sessions[chatId].goalkeepers.push(name.trim());
    else sessions[chatId].players.push(name.trim());
  });

  drawTeams(chatId);
});

/* ================== TEAM DRAW ================== */
function drawTeams(chatId) {
  const s = sessions[chatId];
  if (!s) return;

  const teams = Array.from({ length: s.teams }, () => []);
  const subs = [];

  shuffle(s.goalkeepers);
  shuffle(s.players);

  // assign 1 GK per team
  teams.forEach((t) => {
    if (s.goalkeepers.length) t.push("🧤 " + s.goalkeepers.pop());
  });

  // assign players max 5 per team
  while (s.players.length) {
    let placed = false;
    for (const t of teams) {
      if (t.length < 5 && s.players.length) {
        t.push("⚽ " + s.players.pop());
        placed = true;
      }
    }
    if (!placed) break;
  }

  subs.push(...s.players);

  let text = "🏆 نتیجه تیم‌کشی:\n\n";
  teams.forEach((t, i) => {
    text += `🔹 تیم ${i + 1}\n${t.join("\n")}\n\n`;
  });

  if (subs.length) {
    text += "🔁 تعویضی‌ها:\n" + subs.join("\n");
  }

  bot.sendMessage(chatId, text, {
    reply_markup: {
      inline_keyboard: [[{ text: "🔄 شانس مجدد (ادمین)", callback_data: "REDRAW" }]],
    },
  });
}
