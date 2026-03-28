export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body;
  const message = body?.message;
  if (!message) return res.status(200).json({ ok: true });

  const text = message?.text?.trim().toUpperCase();
  const chatId = message?.chat?.id?.toString();

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

  async function extractLesson(trade) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': ANT_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: `Generate one specific actionable lesson (1-2 sentences) from this resolved prediction market trade.\n\nMarket: "${trade.market_question}"\nDirection: ${trade.direction}\nMy P: ${trade.true_p}% | Market odds: ${trade.market_odds}%\nEdge claimed: ${trade.edge_pp}pp\nOutcome: ${trade.outcome} | Won: ${trade.outcome === trade.direction}\nThesis: ${trade.thesis || ''}\n\nReturn ONLY the lesson text, nothing else.`
          }]
        })
      });
      const d = await r.json();
      return d.content?.[0]?.text?.trim() || '';
    } catch (e) {
      return '';
    }
  }

  // ── Y reply — could be bet placement OR paper trade resolution
  if (text === 'Y' || text === 'YES') {

    // First check for pending paper trade resolutions
    const pendingTrades = await sbFetch('pit_paper_trades', 'status=eq.PENDING_RESOLVE&order=resolved_at.desc&limit=1');

    if (pendingTrades && pendingTrades.length) {
      const trade = pendingTrades[0];
      await sendTg(`⏳ Extracting lesson from: "${trade.market_question?.substring(0, 60)}"...`);

      const lesson = await extractLesson(trade);

      // Close the trade
      await sbUpdate('pit_paper_trades', `id=eq.${trade.id}`, {
        status: 'CLOSED',
        resolved_at: new Date().toISOString(),
        lesson: lesson || null
      });

      // Save lesson to pit_lessons
      if (lesson) {
        await sbInsert('pit_lessons', {
          lesson,
          lesson_type: 'auto',
          market_type: null,
          source: `Paper trade: ${trade.market_question?.substring(0, 50)}`
        });
      }

      const won = trade.outcome === trade.direction;
      await sendTg(
        `${won ? '✅' : '❌'} *PAPER TRADE CLOSED*\n\n` +
        `*${trade.market_question?.substring(0, 80)}*\n` +
        `${trade.direction} → Resolved ${trade.outcome}\n` +
        `P&L: $${trade.pnl >= 0 ? '+' : ''}${trade.pnl}\n\n` +
        `${lesson ? `💡 *Lesson saved to KB:*\n_${lesson.substring(0, 200)}_` : 'No lesson extracted'}`
      );
      return res.status(200).json({ ok: true });
    }

    // No pending paper trade — check for pending real bet signal
    try {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const signals = await sbFetch('pit_signals', `order=created_at.desc&limit=1&bet_placed=eq.false&created_at=gte.${fiveMinAgo}`);

      if (!signals || !signals.length) {
        await sendTg('⚠️ No pending signal or paper trade found.');
        return res.status(200).json({ ok: true });
      }

      const signal = signals[0];
      await sendTg(`⏳ Placing bet: ${signal.direction} on "${signal.market_question?.substring(0, 60)}"...`);

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

  } else if (text === 'N' || text === 'NO') {

    // Check for pending paper trade first
    const pendingTrades = await sbFetch('pit_paper_trades', 'status=eq.PENDING_RESOLVE&order=resolved_at.desc&limit=1');

    if (pendingTrades && pendingTrades.length) {
      await sbUpdate('pit_paper_trades', `id=eq.${pendingTrades[0].id}`, { status: 'OPEN', notified: false });
      await sendTg('✓ Skipped. Trade kept open for manual review.');
      return res.status(200).json({ ok: true });
    }

    // Otherwise skip real bet signal
    try {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const signals = await sbFetch('pit_signals', `order=created_at.desc&limit=1&bet_placed=eq.false&created_at=gte.${fiveMinAgo}`);
      if (signals && signals.length) {
        await sbUpdate('pit_signals', `id=eq.${signals[0].id}`, { processed: true });
      }
      await sendTg('✓ Skipped.');
    } catch (e) {
      await sendTg('✓ Skipped.');
    }
  }

  return res.status(200).json({ ok: true });
}
