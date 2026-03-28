export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const body = req.body;
  const message = body?.message;
  if (!message) return res.status(200).json({ ok: true });

  const text = message?.text?.trim().toUpperCase();
  const chatId = message?.chat?.id?.toString();
  const fromId = message?.from?.id?.toString();

  // Only accept from your chat
  if (chatId !== process.env.TELEGRAM_CHAT_ID && fromId !== process.env.TELEGRAM_CHAT_ID?.replace('-', '')) {
    return res.status(200).json({ ok: true });
  }

  const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN_PIT;
  const SB_URL = process.env.SUPABASE_URL;
  const SB_KEY = process.env.SUPABASE_KEY;

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
      headers: {
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(updates)
    });
  }

  if (text === 'Y' || text === 'YES') {
    // Find most recent unprocessed real signal (within last 5 minutes)
    try {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const signals = await sbFetch(
        'pit_signals',
        `order=created_at.desc&limit=1&bet_placed=eq.false&created_at=gte.${fiveMinAgo}`
      );

      if (!signals || !signals.length) {
        await sendTg('⚠️ No pending signal found within the 5 minute window. Signal may have expired.');
        return res.status(200).json({ ok: true });
      }

      const signal = signals[0];
      await sendTg(`⏳ Placing bet: ${signal.direction} on "${signal.market_question?.substring(0, 60)}"...`);

      // Place the bet via Polymarket API
      const placeResp = await fetch(`${process.env.VERCEL_URL || 'https://pit-terminal.vercel.app'}/api/polymarket?action=place`, {
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
        // Mark signal as processed
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
    try {
      const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const signals = await sbFetch(
        'pit_signals',
        `order=created_at.desc&limit=1&bet_placed=eq.false&created_at=gte.${fiveMinAgo}`
      );

      if (signals && signals.length) {
        await sbUpdate('pit_signals', `id=eq.${signals[0].id}`, { processed: true });
      }

      await sendTg('✓ Skipped. Signal marked as passed.');
    } catch (e) {
      await sendTg('✓ Skipped.');
    }
  }

  return res.status(200).json({ ok: true });
}
