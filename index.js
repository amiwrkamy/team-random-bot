import random
from telegram import (
    Update,
    InlineKeyboardButton,
    InlineKeyboardMarkup
)
from telegram.ext import (
    ApplicationBuilder,
    CommandHandler,
    CallbackQueryHandler,
    ContextTypes
)

TOKEN = "PUT_YOUR_TOKEN_HERE"

# ---------- STATE ----------
games = {}  # chat_id -> game data


def get_name(user):
    return f"@{user.username}" if user.username else user.first_name


# ---------- START ----------
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [
        [InlineKeyboardButton("👤 داخل ربات", callback_data="mode_private")],
        [InlineKeyboardButton("👥 داخل گروه", callback_data="mode_group")]
    ]
    await update.message.reply_text(
        "🏟 تیم‌چینی کجا انجام بشه؟",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )


# ---------- MODE ----------
async def choose_mode(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    keyboard = [
        [
            InlineKeyboardButton("1️⃣", callback_data="teams_1"),
            InlineKeyboardButton("2️⃣", callback_data="teams_2"),
            InlineKeyboardButton("3️⃣", callback_data="teams_3"),
            InlineKeyboardButton("4️⃣", callback_data="teams_4"),
        ]
    ]
    await query.edit_message_text(
        "🧮 چند تیم می‌خوای؟",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )


# ---------- INIT GAME ----------
async def init_game(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    chat_id = query.message.chat_id
    team_count = int(query.data.split("_")[1])

    games[chat_id] = {
        "teams": [
            {"gk": None, "players": [], "subs": []}
            for _ in range(team_count)
        ]
    }

    keyboard = [
        [InlineKeyboardButton("⚽ بازیکن", callback_data="join_player")],
        [InlineKeyboardButton("🧤 دروازه‌بان", callback_data="join_gk")],
    ]

    await query.edit_message_text(
        "🏆 تیم‌چینی شروع شد!\nنقش خودتو انتخاب کن 👇",
        reply_markup=InlineKeyboardMarkup(keyboard)
    )


# ---------- JOIN GK ----------
async def join_gk(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    chat_id = query.message.chat_id
    user = query.from_user
    name = get_name(user)

    game = games.get(chat_id)
    if not game:
        return

    available = [t for t in game["teams"] if t["gk"] is None]
    if not available:
        await query.answer("❌ همه تیم‌ها GK دارن", show_alert=True)
        return

    team = random.choice(available)
    team["gk"] = name

    await update_teams(query)


# ---------- JOIN PLAYER ----------
async def join_player(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()

    chat_id = query.message.chat_id
    user = query.from_user
    name = get_name(user)

    game = games.get(chat_id)
    if not game:
        return

    available = [t for t in game["teams"] if len(t["players"]) < 4]

    if available:
        team = random.choice(available)
        team["players"].append(name)
    else:
        random.choice(game["teams"])["subs"].append(name)

    await update_teams(query)


# ---------- UPDATE MESSAGE ----------
async def update_teams(query):
    game = games[query.message.chat_id]

    text = ""
    for i, t in enumerate(game["teams"], 1):
        text += f"🏆 تیم {i}:\n"
        if t["gk"]:
            text += f"🧤 {t['gk']}\n"
        for p in t["players"]:
            text += f"⚽ {p}\n"
        for s in t["subs"]:
            text += f"🔄 {s}\n"
        text += "\n"

    keyboard = [
        [InlineKeyboardButton("⚽ بازیکن", callback_data="join_player")],
        [InlineKeyboardButton("🧤 دروازه‌بان", callback_data="join_gk")],
    ]

    await query.edit_message_text(
        text,
        reply_markup=InlineKeyboardMarkup(keyboard)
    )


# ---------- MAIN ----------
def main():
    app = ApplicationBuilder().token(TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CallbackQueryHandler(choose_mode, pattern="mode_"))
    app.add_handler(CallbackQueryHandler(init_game, pattern="teams_"))
    app.add_handler(CallbackQueryHandler(join_player, pattern="join_player"))
    app.add_handler(CallbackQueryHandler(join_gk, pattern="join_gk"))

    app.run_polling()


if __name__ == "__main__":
    main()
