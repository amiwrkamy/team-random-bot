import os
from aiogram import Bot, Dispatcher, executor, types
from aiogram.types import InlineKeyboardMarkup, InlineKeyboardButton
from backend import shuffle_teams

TOKEN = os.getenv("TOKEN")  # توکن از Render ENV

bot = Bot(token=TOKEN)
dp = Dispatcher(bot)

sessions = {}

# ---------- Keyboards ----------
def start_keyboard():
    kb = InlineKeyboardMarkup(row_width=2)
    kb.add(
        InlineKeyboardButton("🤖 داخل ربات", callback_data="private"),
        InlineKeyboardButton("👥 داخل گروه", callback_data="group")
    )
    return kb

def team_keyboard(prefix):
    kb = InlineKeyboardMarkup(row_width=3)
    for i in [2, 3, 4]:
        kb.add(
            InlineKeyboardButton(f"👕 {i} تیم", callback_data=f"{prefix}_{i}")
        )
    return kb

def role_keyboard():
    kb = InlineKeyboardMarkup(row_width=2)
    kb.add(
        InlineKeyboardButton("⚽ بازیکن", callback_data="player"),
        InlineKeyboardButton("🧤 دروازه‌بان", callback_data="gk")
    )
    return kb

def admin_keyboard():
    kb = InlineKeyboardMarkup()
    kb.add(InlineKeyboardButton("🔁 شانس مجدد", callback_data="reshuffle"))
    return kb

# ---------- Start ----------
@dp.message_handler(commands=["start"])
async def start(msg: types.Message):
    await msg.answer(
        "🎲 قرعه‌کشی شانسی تیم‌ها\nانتخاب کن:",
        reply_markup=start_keyboard()
    )

# ---------- Private ----------
@dp.callback_query_handler(lambda c: c.data == "private")
async def private_mode(call: types.CallbackQuery):
    sessions[call.from_user.id] = {
        "mode": "private",
        "players": [],
        "goalkeepers": [],
        "team_count": 0
    }
    await call.message.answer(
        "👕 تعداد تیم‌ها:",
        reply_markup=team_keyboard("p")
    )

@dp.callback_query_handler(lambda c: c.data.startswith("p_"))
async def private_team(call: types.CallbackQuery):
    sessions[call.from_user.id]["team_count"] = int(call.data.split("_")[1])
    await call.message.answer(
        "✍️ اسامی رو بفرست:\n"
        "علی - بازیکن\n"
        "رضا - دروازه‌بان\n\n"
        "بعدش /draw"
    )

@dp.message_handler(lambda m: "-" in m.text)
async def receive_names(msg: types.Message):
    s = sessions.get(msg.from_user.id)
    if not s:
        return

    name, role = map(str.strip, msg.text.split("-"))
    if role == "دروازه‌بان":
        if name not in s["goalkeepers"]:
            s["goalkeepers"].append(name)
    else:
        if name not in s["players"]:
            s["players"].append(name)

    await msg.reply("✅ ثبت شد")

@dp.message_handler(commands=["draw"])
async def draw_private(msg: types.Message):
    s = sessions.get(msg.from_user.id)
    if not s or s["team_count"] == 0:
        return

    teams = shuffle_teams(
        s["players"],
        s["goalkeepers"],
        s["team_count"]
    )

    text = "🎯 نتیجه قرعه‌کشی:\n\n"
    for t, members in teams.items():
        text += f"👕 تیم {t}:\n"
        for icon, name in members:
            text += f"{icon} {name}\n"
        text += "\n"

    await msg.answer(text)

# ---------- Group ----------
@dp.callback_query_handler(lambda c: c.data == "group")
async def group_link(call: types.CallbackQuery):
    me = await bot.get_me()
    await call.message.answer(
        "🔗 افزودن بات به گروه:\n"
        f"https://t.me/{me.username}?startgroup=true"
    )

@dp.message_handler(content_types=types.ContentType.NEW_CHAT_MEMBERS)
async def bot_added(msg: types.Message):
    me = await bot.get_me()
    if msg.new_chat_members[0].id == me.id:
        sessions[msg.chat.id] = {
            "mode": "group",
            "players": {},
            "goalkeepers": {},
            "team_count": 0,
            "admin": msg.from_user.id
        }
        await msg.answer(
            "👋 بات فعال شد\n👕 تعداد تیم‌ها:",
            reply_markup=team_keyboard("g")
        )

@dp.callback_query_handler(lambda c: c.data.startswith("g_"))
async def group_team(call: types.CallbackQuery):
    s = sessions[call.message.chat.id]
    s["team_count"] = int(call.data.split("_")[1])
    await call.message.answer(
        "🎮 نقش خودتو انتخاب کن:",
        reply_markup=role_keyboard()
    )

@dp.callback_query_handler(lambda c: c.data in ["player", "gk"])
async def choose_role(call: types.CallbackQuery):
    s = sessions[call.message.chat.id]
    uid = call.from_user.id

    if uid in s["players"] or uid in s["goalkeepers"]:
        await call.answer("❌ فقط یک بار می‌تونی انتخاب کنی", show_alert=True)
        return

    if call.data == "gk":
        s["goalkeepers"][uid] = call.from_user.full_name
    else:
        s["players"][uid] = call.from_user.full_name

    await call.answer("✅ ثبت شد")

@dp.callback_query_handler(lambda c: c.data == "reshuffle")
async def reshuffle(call: types.CallbackQuery):
    s = sessions[call.message.chat.id]
    if call.from_user.id != s["admin"]:
        await call.answer("❌ فقط ادمین", show_alert=True)
        return

    teams = shuffle_teams(
        list(s["players"].values()),
        list(s["goalkeepers"].values()),
        s["team_count"]
    )

    text = "🔁 قرعه‌کشی مجدد:\n\n"
    for t, members in teams.items():
        text += f"👕 تیم {t}:\n"
        for icon, name in members:
            text += f"{icon} {name}\n"
        text += "\n"

    await call.message.answer(text)

# ---------- Run ----------
if __name__ == "__main__":
    executor.start_polling(dp)
