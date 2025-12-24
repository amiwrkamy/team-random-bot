
import TelegramBot from "node-telegram-bot-api";

const TOKEN = process.env.BOT_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "سلام 👋\nاسم بازیکن‌ها رو با فاصله بفرست تا تیم‌بندی کنم\n\nمثال:\nali reza sara mina"
  );
});

bot.on("message", (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const players = msg.text.split(" ").filter(Boolean);

  if (players.length < 2) {
    bot.sendMessage(msg.chat.id, "حداقل ۲ اسم بفرست 🙂");
    return;
  }

  const shuffled = players.sort(() => Math.random() - 0.5);
  const team1 = [];
  const team2 = [];

  shuffled.forEach((p, i) => {
    (i % 2 === 0 ? team1 : team2).push(p);
  });

  bot.sendMessage(
    msg.chat.id,
    `🏆 تیم ۱:\n${team1.join(" , ")}\n\n🔥 تیم ۲:\n${team2.join(" , ")}`
  );
});
