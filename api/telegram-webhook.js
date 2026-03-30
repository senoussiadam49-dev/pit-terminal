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
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          messages: [{
            role: 'user',
            content: `You are extracting a calibration lesson from a resolved prediction market trade. This lesson will be permanently saved to an AI knowledge base and used to improve future trading decisions. Make it specific, actionable, and grounded in what actually happened.

TRADE DETAILS:
Market: "${trade.market_question}"
Direction: ${trade.direction} @ ${trade.market_odds}%
My true P estimate: ${trade.true_p}%
Edge claimed: ${trade.edge_pp}pp
Outcome: ${trade.outcome} | ${trade.outcome === trade.direction ? 'WON' : 'LOST'}
Original thesis: ${trade.thesis || 'not recorded'}

TRADER CONTEXT (what actually happened):
${resolutionContext}

Extract a structured lesson with these components:
1. WHAT HAPPENED: What specifically triggered the resolution
2. THESIS ASSESSMENT: Did the thesis hold, break, or was it a technicality?
3. CALIBRATION NOTE: Was the probability estimate right or wrong and why?
4. ACTIONABLE RULE: One specific rule to apply to similar markets in future

Format your response as exactly two lines:
LESSON: [2-3 sentences combining all four components into one actionable insight]
PATTERN: [One sentence: what type of market or situation this applies to in future]

Return ONLY the LESSON and PATTERN lines, nothing else.`
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
      const lessonMatch = lesson.match(/LESSON:\s*(.+?)(?=PATTERN:|$)/s);
      const patternMatch = lesson.match(/PATTERN:\s*(.+)/s);
      const lessonText = lessonMatch ? lessonMatch[1].trim() : lesson;
      const patternText = patternMatch ? patternMatch[1].trim() : null;

      await sbInsert('pit_lessons', {
        lesson: lessonText,
        lesson_type: 'auto',
        market_type: null,
        source: `Paper trade: ${trade.market_question?.substring(0, 50)}`
      });

      if (patternText) {
        await sbInsert('pit_lessons', {
          lesson: `PATTERN: ${patternText}`,
          lesson_type: 'auto',
          market_type: null,
          source: `Pattern from: ${trade.market_question?.substring(0, 50)}`
        });
      }
    }

    const won = trade.outcome === trade.direction;
    await sendTg(
      `${won ? '✅' : '❌'} *PAPER TRADE CLOSED*\n\n` +
      `*${trade.market_question?.substring(0, 80)}*\n` +
      `${trade.direction} → Resolved ${trade.outcome}\n` +
      `P&L: $${trade.pnl >= 0 ? '+' : ''}${trade.pnl}\n\n` +
      `💡 *Lesson saved to KB:*\n_${lesson ? lesson.substring(0, 400) : 'None extracted'}_`
    );
    return res.status(200).json({ ok: true });
  }

  // ── Handle Y/YES ──────────────────────────────────────────────────────
  if (textUpper === 'Y' || textUpper === 'YES') {
    try {
      // Find signal by reply-to first, then 5 min window
      let signal = await findSignalByReplyId(replyToMessageId);
      if (!signal) {
        const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const signals = await sbFetch('pit_signals', `order=created_at.desc&limit=1&bet_placed=eq.false&created_at=gte.${fiveMinAgo}`);
        signal = signals && signals.length ? signals[0] : null;
      }

      if (!signal) {
        await sendTg('⚠️ No signal found. Reply directly to the alert message next time — no time limit that way.');
        return res.status(200).json({ ok: true });
      }

      // ── Check calibration status ──────────────────────────────────
      const calRows = await sbFetch('pit_calibration', 'id=eq.1&limit=1');
      const cal = calRows && calRows.length ? calRows[0] : null;
      const isCalibrated = cal && cal.is_calibrated === true;
      const tradesResolved = cal ? (cal.trades_resolved || 0) : 0;
      const brierScore = cal ? (cal.brier_score || 0.25) : 0.25;

      // ── During calibration — always paper trade ───────────────────
      if (!isCalibrated) {
        const stake = signal.kelly_stake || 2.0;

        await sbInsert('pit_paper_trades', {
          market_question: signal.market_question,
          condition_id:    signal.condition_id,
          token_id:        signal.token_id || '',
          direction:       signal.direction,
          market_odds:     signal.market_odds,
          true_p:          signal.true_p,
          edge_pp:         signal.edge_pp,
          stake:           stake,
          resolution_date: signal.resolution_date,
          thesis:          signal.thesis,
          status:          'OPEN',
          scanner:         'C'
        });

        await sbUpdate('pit_signals', `id=eq.${signal.id}`, { bet_placed: true, processed: true });

        await sendTg(
          `📝 *PAPER TRADE LOGGED*\n\n` +
          `*${signal.market_question?.substring(0, 80)}*\n` +
          `${signal.direction} @ ${signal.market_odds}%\n` +
          `Stake: $${stake} (paper)\n\n` +
          `📊 _Calibration: ${tradesResolved}/${30} trades | Brier: ${brierScore.toFixed(3)}_\n` +
          `_${30 - tradesResolved} more resolved trades needed for real money_`
        );
        return res.status(200).json({ ok: true });
      }

      // ── Calibrated — place real bet ───────────────────────────────
      const stake = signal.kelly_stake || 2.0;
      await sendTg(`⏳ Placing bet: *${signal.direction}* on _"${signal.market_question?.substring(0, 60)}"_...`);

      const placeResp = await fetch('https://pit-terminal.vercel.app/api/polymarket?action=place', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tokenId:  signal.token_id,
          side:     'BUY',
          amount:   stake,
          price:    signal.direction === 'YES' ? signal.market_odds / 100 : (100 - signal.market_odds) / 100,
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
          `Amount: $${stake} USDC\n\n` +
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
