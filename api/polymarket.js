const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const CHAIN_ID = 137;

let _cachedCreds = null;

async function getApiCreds() {
  if (_cachedCreds) return _cachedCreds;

  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  const funder = process.env.POLYMARKET_FUNDER;

  if (!pk || !funder) {
    throw new Error('POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER must be set in Vercel env vars');
  }

  const { ethers } = await import('ethers');
  const wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk);
  const ts = Math.floor(Date.now() / 1000).toString();

  const sig = await wallet.signMessage(`This message attests that I am the owner/operator of this account\n\nAddress: ${funder}\nTimestamp: ${ts}\nNonce: 0`);

  const r = await fetch(`${CLOB_HOST}/auth/derive-api-key`, {
    method: 'GET',
    headers: {
      'POLY_ADDRESS': funder,
      'POLY_SIGNATURE': sig,
      'POLY_TIMESTAMP': ts,
      'POLY_NONCE': '0',
      'POLY_SIGNATURE_TYPE': '0',
    },
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`CLOB auth failed: ${r.status} — ${text}`);
  }

  const creds = await r.json();
  _cachedCreds = creds;
  return creds;
}

async function placeOrder({ tokenId, side, amount, price, tickSize, negRisk }) {
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  const funder = process.env.POLYMARKET_FUNDER;
  const { ethers } = await import('ethers');
  const wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk);
  const creds = await getApiCreds();

  const orderData = {
    maker: funder,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId,
    makerAmount: Math.round(amount * 1e6).toString(),
    takerAmount: Math.round(amount / price * 1e6).toString(),
    side: side === 'BUY' ? 0 : 1,
    feeRateBps: '0',
    nonce: '0',
    signer: wallet.address,
    expiration: '0',
    signatureType: 0,
  };

  const msgHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(orderData)));
  const sig = await wallet.signMessage(ethers.getBytes(msgHash));
  orderData.signature = sig;

  const ts = Math.floor(Date.now() / 1000).toString();
  const hmacMsg = ts + 'POST' + '/order' + JSON.stringify(orderData);
  const key = ethers.toUtf8Bytes(creds.secret);
  const msg = ethers.toUtf8Bytes(hmacMsg);

  const r = await fetch(`${CLOB_HOST}/order`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'POLY_ADDRESS': funder,
      'POLY_SIGNATURE': sig,
      'POLY_TIMESTAMP': ts,
      'POLY_NONCE': '0',
      'POLY_API_KEY': creds.apiKey,
      'POLY_PASSPHRASE': creds.passphrase,
    },
    body: JSON.stringify(orderData),
  });

  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Order failed: ${r.status} — ${text}`);
  }
  return await r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action;

  try {
    if (action === 'debug') {
      const { ethers } = await import('ethers');
      const pk = process.env.POLYMARKET_PRIVATE_KEY;
      const funder = process.env.POLYMARKET_FUNDER;
      const wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk);
      return res.json({ derivedAddress: wallet.address, funder, match: wallet.address.toLowerCase() === funder.toLowerCase() });
    }

    if (action === 'auth') {
      const creds = await getApiCreds();
      return res.json({ ok: true, apiKey: creds.apiKey });
    }

    if (action === 'balance') {
      const funder = process.env.POLYMARKET_FUNDER;
      const r = await fetch(`https://data-api.polymarket.com/balance?user=${funder}`);
      const d = await r.json();
      return res.json({ ok: true, balance: d });
    }

    if (action === 'search') {
      const { query } = req.body || {};
      const r = await fetch(`${GAMMA_HOST}/markets?search=${encodeURIComponent(query || '')}&limit=10&active=true&closed=false`);
      const d = await r.json();
      return res.json({ ok: true, markets: d.markets || d || [] });
    }

    if (action === 'place') {
      const body = req.body || {};
      const result = await placeOrder(body);
      return res.json({ ok: true, ...result });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
