// جایگزین برای join_player
bot.action('join_player', async ctx => {
  if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.answerCbQuery('این دکمه فقط در گروه کار می‌کند.');
  const chatId = ctx.chat.id;
  // سریع answer کن تا spinner بسته بشه
  await ctx.answerCbQuery().catch(()=>{});
  await withGroupLock(chatId, async () => {
    try {
      const state = store.chats[String(chatId)];
      if (!state) return await ctx.answerCbQuery('فعالی نیست.');
      const uid = String(ctx.from.id);
      if (state.registered[uid]) return await ctx.answerCbQuery('⛔ شما قبلاً ثبت‌نام کردید.');

      const res = assignEntry(state, { id: uid, name: displayName(ctx.from), role: 'player' });
      if (!res.ok) return await ctx.answerCbQuery('ثبت نام امکان‌پذیر نیست.');

      await ctx.answerCbQuery(res.substitute ? 'شما به‌عنوان تعویضی ثبت شدید.' : '✅ ثبت شد');

      // اگر message_id موجود نیست (شاید پیام قبلی حذف شده) دوباره ارسال کن و آی‌دی ذخیره کن
      if (!state.message_id) {
        const sent = await ctx.reply(formatTeamsText(state), { reply_markup: buildKeyboard() });
        state.message_id = sent.message_id; saveStore(store);
      } else {
        await safeEditMessage(chatId, state.message_id, formatTeamsText(state), buildKeyboard());
      }
    } catch (err) {
      console.error('join_player error', err);
      try { await ctx.answerCbQuery('خطا در ثبت - دوباره تلاش کنید'); } catch(e){}
    }
  });
});

// جایگزین برای join_keeper
bot.action('join_keeper', async ctx => {
  if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.answerCbQuery('این دکمه فقط در گروه کار می‌کند.');
  const chatId = ctx.chat.id;
  await ctx.answerCbQuery().catch(()=>{});
  await withGroupLock(chatId, async () => {
    try {
      const state = store.chats[String(chatId)];
      if (!state) return await ctx.answerCbQuery('فعالی نیست.');
      const uid = String(ctx.from.id);
      if (state.registered[uid]) return await ctx.answerCbQuery('⛔ شما قبلاً ثبت‌نام کردید.');

      const slot = chooseKeeperTeam(state);
      if (slot === null) return await ctx.answerCbQuery('همهٔ تیم‌ها دروازه‌بان دارند.');

      const res = assignEntry(state, { id: uid, name: displayName(ctx.from), role: 'keeper' });
      if (!res.ok) return await ctx.answerCbQuery('ثبت نام ممکن نیست.');
      await ctx.answerCbQuery('🧤 دروازه‌بان ثبت شد');

      if (!state.message_id) {
        const sent = await ctx.reply(formatTeamsText(state), { reply_markup: buildKeyboard() });
        state.message_id = sent.message_id; saveStore(store);
      } else {
        await safeEditMessage(chatId, state.message_id, formatTeamsText(state), buildKeyboard());
      }
    } catch (err) {
      console.error('join_keeper error', err);
      try { await ctx.answerCbQuery('خطا در ثبت - دوباره تلاش کنید'); } catch(e){}
    }
  });
});

// جایگزین برای reshuffle (فقط ادمین)
bot.action('reshuffle', async ctx => {
  if (!['group','supergroup'].includes(ctx.chat.type)) return ctx.answerCbQuery();
  // check admin
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    if (!['administrator','creator'].includes(member.status)) return ctx.answerCbQuery('فقط ادمین می‌تواند.');
  } catch(e) { return ctx.answerCbQuery('خطا'); }

  const chatId = ctx.chat.id;
  await ctx.answerCbQuery().catch(()=>{});
  await withGroupLock(chatId, async () => {
    try {
      const state = store.chats[String(chatId)];
      if (!state) return await ctx.answerCbQuery('فعالی نیست.');
      reshuffleAll(state);
      await ctx.answerCbQuery('🔀 دوباره شانسی و متعادل شد');
      if (!state.message_id) {
        const sent = await ctx.reply(formatTeamsText(state), { reply_markup: buildKeyboard() });
        state.message_id = sent.message_id; saveStore(store);
      } else {
        await safeEditMessage(chatId, state.message_id, formatTeamsText(state), buildKeyboard());
      }
    } catch (err) {
      console.error('reshuffle error', err);
      try { await ctx.answerCbQuery('خطا در قاطی‌کردن دوباره'); } catch(e){}
    }
  });
});
