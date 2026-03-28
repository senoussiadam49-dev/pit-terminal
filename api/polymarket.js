const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const CHAIN_ID = 137;

async function getApiCreds() {
  const apiKey = process.env.POLYMARKET_API_KEY;
  const secret = process.env.POLYMARKET_SECRET;
  const passphrase = process.env.POLYMARKET_PASSPHRASE;
  if (!apiKey || !secret || !passphrase) throw new Error('Missing Polymarket API credentials');
  return { apiKey, secret, passphrase };
}

async function placeOrder({ tokenId, side, amount, price, tickSize, negRisk }) {
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  const funder = process.env.POLYMARKET_FUNDER;
  const { ethers } = await import('ethers');
  const wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk);
  const creds = await getApiCreds();

  const ts = Math.floor(Date.now() / 1000);
  const order = {
    salt: Date.now(),
    maker: funder,
    signer: wallet.address,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId,
    makerAmount: side === 'BUY' ? Math.floor(amount * 1e6).toString() : Math.floor(amount / price * 1e6).toString(),
    takerAmount: side === 'BUY' ? Math.floor(amount / price * 1e6).toString() : Math.floor(amount * 1e6).toString(),
    expiration: (ts + 3600).toString(),
    nonce: '0',
    feeRateBps: '0',
    side: side === 'BUY' ? 0 : 1,
    signatureType: 2,
  };

  const orderDomain = {
    name: 'CTFExchange',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  };

  const orderTypes = {
    Order: [
      { name: 'salt', type: 'uint256' },
      { name: 'maker', type: 'address' },
      { name: 'signer', type: 'address' },
      { name: 'taker', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'makerAmount', type: 'uint256' },
      { name: 'takerAmount', type: 'uint256' },
      { name: 'expiration', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'feeRateBps', type: 'uint256' },
      { name: 'side', type: 'uint8' },
      { name: 'signatureType', type: 'uint8' },
    ],
  };

  const signature = await wallet.signTypedData(orderDomain, orderTypes, order);
  const signedOrder = { ...order, signature };

  const hmacTs = Math.floor(Date.now() / 1000).toString();
  const bodyStr = JSON.stringify({ order: signedOrder, owner: funder, orderType: 'GTC' });
  const hmacSig = await buildHmac(creds.secret, 'POST', '/order', bodyStr, hmacTs);

  const resp = await fetch(`${CLOB_HOST}/order`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'POLY_ADDRESS': funder,
      'POLY_SIGNATURE': hmacSig,
      'POLY_TIMESTAMP': hmacTs,
      'POLY_API_KEY': creds.apiKey,
      'POLY_PASSPHRASE': creds.passphrase,
    },
    body: bodyStr,
  });

  return resp.json();
}

async function buildHmac(secret, method, path, body, ts) {
  const { createHmac } = await import('crypto');
  const msg = ts + method.toUpperCase() + path + (body || '');
  const secretBytes = Buffer.from(secret, 'base64');
  const hmac = createHmac('sha256', secretBytes);
  hmac.update(msg);
  return hmac.digest('base64');
}

async function getBalance() {
  const funder = process.env.POLYMARKET_FUNDER;
  const r = await fetch(`https://data-api.polymarket.com/balance?user=${funder}`);
  const d = await r.json();
  return d;
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
      const bal = await getBalance();
      return res.json({ ok: true, balance: bal });
    }

    if (action === 'search') {
      const query = req.body?.query || req.query.query || '';
      const r = await fetch(`${GAMMA_HOST}/markets?search=${encodeURIComponent(query)}&limit=10&active=true&closed=false`);
      const d = await r.json();
      return res.json({ ok: true, markets: d.markets || d || [] });
    }

    if (action === 'place') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
      const body = req.body || {};
      if (body.amount > 25) return res.status(400).json({ error: 'Max $25 per bet' });
      const result = await placeOrder(body);
      return res.json({ ok: !result.error, ...result });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
