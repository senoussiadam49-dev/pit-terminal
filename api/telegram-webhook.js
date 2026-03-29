export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body;
  const message = body?.message;
  if (!message) return res.status(200).json({ ok: true });

  const text = message?.text?.trim();
  const textUpper = text?.toUpperCase();
  const chatId = message?.chat?.id?.toString();
  const replyToMessageId = message?.reply_to_message?.message_id;

  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN_PIT;
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;
  const ANT_KEY = process.env.ANTHROPIC_API_KEY;

  async function sendTg(msg) {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: msg, parse_mode: 'Markdown' })
    });
  }

  async function sbFetch(table, params) {
    const r = await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
    });
    return r.json();
  }

  async function sbUpdate(table, params, updates) {
    await fetch(`${SB_URL}/rest/v1/${table}?${params}`, {
      method: 'PATCH',
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
  }

  async function sbInsert(table, row) {
    await fetch(`${SB_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify(row)
    });
  }

  async function extractLesson(trade, resolutionContext) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANT_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{
            role: 'user',
            content: `Generate one specific actionable lesson (2-3 sentences) from this resolved prediction market trade.\n\nMarket: "${trade.market_question}"\nDirection: ${trade.direction}\nMarket odds: ${trade.market_odds}% | My true P: ${trade.true_p}%\nEdge claimed: ${trade.edge_pp}pp\nOutcome: ${trade.outcome} | Won: ${trade.outcome === trade.direction}\nThesis: ${trade.thesis || ''}\n\nWhat actually happened:\n${resolutionContext}\n\nReturn ONLY the lesson text.`
          }]
        })
      });
      const d = await r.json();
      return d.content?.[0]?.text?.trim() || '';
    } catch (e) { return ''; }
  }

  // ── Find signal by reply-to message ID ───────────────────────────────
  async function findSignalByReplyId(messageId) {
    if (!messageId) return null;
    const results = await sbFetch('pit_signals', `telegram_message_id=eq.${messageId}&bet_placed=eq.false&limit=1`);
    return results && results.length ? results[0] : null;
  }

  // ── Check for pending paper trade ────────────────────────────────────
  const pendingTrades = await sbFetch('pit_paper_trades', 'status=eq.PENDING_RESOLVE&order=updated_at.desc&limit=1');
  const hasPending = pendingTrades && pendingTrades.length > 0;

  // ── Handle N/NO ───────────────────────────────────────────────────────
  if (textUpper === 'N' || textUpper === 'NO') {
    if (hasPending) {
      await sbUpdate('pit_paper_trades', `id=eq.${pendingTrades[0].id}`, { status: 'OPEN', notified: false });
      await sendTg('✓ Skipped. Trade kept open for manual review.');
      return res.status(200).json({ ok: true });
    }
    // Skip signal — check reply-to first, then fallback to recent
    const repliedSignal = await findSignalByReplyId(replyToMessageId);
    if (repliedSignal) {
      await sbUpdate('pit_signals', `id=eq.${repliedSignal.id}`, { processed: true });
      await sendTg('✓ Skipped.');
    } else {
      try {
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const signals = await sbFetch('pit_signals', `order=created_at.desc&limit=1&bet_placed=eq.false&created_at=gte.${fiveMinAgo}`);
        if (signals && signals.length) {
          await sbUpdate('pit_signals', `id=eq.${signals[0].id}`, { processed: true });
        }
        await sendTg('✓ Skipped.');
      } catch (e) { await sendTg('✓ Skipped.'); }
    }
    return res.status(200).json({ ok: true });
  }

  // ── If pending paper trade resolution, handle it ──────────────────────
  if (hasPending) {
    const trade = pendingTrades[0];
    const isSimpleConfirm = textUpper === 'Y' || textUpper === 'YES';
    const resolutionContext = isSimpleConfirm ? `Market resolved ${trade.outcome}. Trader confirmed.` : text;

    await sendTg(`⏳ Extracting lesson from: _"${trade.market_question?.substring(0, 60)}"_...`);
    const lesson = await extractLesson(trade, resolutionContext);

    await sbUpdate('pit_paper_trades', `id=eq.${trade.id}`, {
      status: 'CLOSED', resolved_at: new Date().toISOString(), lesson: lesson || null
    });

    if (lesson) {
      await sbInsert('pit_lessons', { lesson, lesson_type: 'auto', market_type: null, source: `Paper trade: ${trade.market_question?.substring(0, 50)}` });
    }

    const won = trade.outcome === trade.direction;
    await sendTg(
      `${won ? '✅' : '❌'} *PAPER TRADE CLOSED*\n\n` +
      `*${trade.market_question?.substring(0, 80)}*\n` +
      `${trade.direction} → Resolved ${trade.outcome}\n` +
      `P&L: $${trade.pnl >= 0 ? '+' : ''}${trade.pnl}\n\n` +
      `💡 *Lesson saved to KB:*\n_${lesson ? lesson.substring(0, 300) : 'None extracted'}_`
    );
    return res.status(200).json({ ok: true });
  }

  // ── Handle Y/YES — place bet ──────────────────────────────────────────
  if (textUpper === 'Y' || textUpper === 'YES') {
    try {
      // First try to find signal by reply-to message ID (no time limit)
      let signal = await findSignalByReplyId(replyToMessageId);

      // Fallback to 5 min window if not a reply
      if (!signal) {
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const signals = await sbFetch('pit_signals', `order=created_at.desc&limit=1&bet_placed=eq.false&created_at=gte.${fiveMinAgo}`);
        signal = signals && signals.length ? signals[0] : null;
      }

      if (!signal) {
        await sendTg('⚠️ No signal found. Reply directly to the alert message next time — no time limit that way.');
        return res.status(200).json({ ok: true });
      }

      await sendTg(`⏳ Placing bet: *${signal.direction}* on _"${signal.market_question?.substring(0, 60)}"_...`);

      const placeResp = await fetch('https://pit-terminal.vercel.app/api/polymarket?action=place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenId: signal.token_id,
          side: 'BUY',
          amount: 25,
          price: signal.direction === 'YES' ? signal.market_odds / 100 : (100 - signal.market_odds) / 100,
          question: signal.market_question,
          marketId: signal.condition_id
        })
      });

      const result = await placeResp.json();

      if (result.ok) {
        await sbUpdate('pit_signals', `id=eq.${signal.id}`, { bet_placed: true, processed: true });
        await sendTg(
          `✅ *BET PLACED*\n\n` +
          `*${signal.market_question?.substring(0, 80)}*\n` +
          `${signal.direction} @ ${signal.market_odds}%\n` +
          `Amount: $25 USDC\n\n` +
          `Order ID: ${result.orderId || 'confirmed'}`
        );
      } else {
        await sendTg(`❌ Bet failed: ${result.error || 'Unknown error'}\n\nPlace manually on Polymarket.`);
      }
    } catch (e) {
      await sendTg(`❌ Error: ${e.message}`);
    }
  }

  return res.status(200).json({ ok: true });
}
