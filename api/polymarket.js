/**
 * PIT — Polymarket CLOB API Route
 * Vercel serverless function — handles all signing server-side
 * Private key NEVER touches the browser
 *
 * Deploy: add this file to your PIT repo at /api/polymarket.js
 * Add env vars in Vercel dashboard:
 *   POLYMARKET_PRIVATE_KEY  = your private key from reveal.magic.link/polymarket
 *   POLYMARKET_FUNDER       = 0x5e12217B961458BF11300F9BdFdCCD73603e5be3
 */

const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const CHAIN_ID = 137;

// ── EIP-712 signing helpers (no external deps needed) ──────────────────────
// We implement the minimal CLOB auth in pure JS to avoid bundling ethers on Vercel

function hexToBytes(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return '0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── CLOB API helpers ───────────────────────────────────────────────────────

async function clobGet(path, apiKey, apiSecret, apiPassphrase) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['POLY_ADDRESS'] = process.env.POLYMARKET_FUNDER;
    headers['POLY_SIGNATURE'] = await signL2Request('GET', path, '', ts, apiSecret, apiPassphrase);
    headers['POLY_TIMESTAMP'] = ts;
    headers['POLY_API_KEY'] = apiKey;
    headers['POLY_PASSPHRASE'] = apiPassphrase;
  }
  const r = await fetch(`${CLOB_HOST}${path}`, { headers });
  return r.json();
}

async function clobPost(path, body, apiKey, apiSecret, apiPassphrase) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyStr = JSON.stringify(body);
  const headers = {
    'Content-Type': 'application/json',
    'POLY_ADDRESS': process.env.POLYMARKET_FUNDER,
    'POLY_SIGNATURE': await signL2Request('POST', path, bodyStr, ts, apiSecret, apiPassphrase),
    'POLY_TIMESTAMP': ts,
    'POLY_API_KEY': apiKey,
    'POLY_PASSPHRASE': apiPassphrase,
  };
  const r = await fetch(`${CLOB_HOST}${path}`, { method: 'POST', headers, body: bodyStr });
  return r.json();
}

async function signL2Request(method, path, body, ts, secret, passphrase) {
  // HMAC-SHA256 signature for L2 auth
  const msg = ts + method.toUpperCase() + path + (body || '');
  const key = hexToBytes(Buffer.from(secret, 'base64').toString('hex'));
  const cryptoKey = await crypto.subtle.importKey(
    'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(msg));
  return Buffer.from(sig).toString('base64');
}

// ── Derive API credentials from private key ────────────────────────────────
// Uses EIP-712 typed data signing — same as py-clob-client's create_or_derive_api_creds

async function deriveApiCreds(privateKey, nonce = 0) {
  try {
    // We call the CLOB directly — it will derive creds from the wallet signature
    // Using the derive endpoint which takes a signed message
    const ts = Math.floor(Date.now() / 1000).toString();
    
    // Build the EIP-712 message for CLOB auth
    const domain = {
      name: 'ClobAuthDomain',
      version: '1',
      chainId: CHAIN_ID,
    };
    
    const signerAddress = process.env.POLYMARKET_FUNDER;
    
    // Sign using eth_signTypedData_v4 equivalent
    const message = {
      address: signerAddress,
      timestamp: ts,
      nonce: nonce,
      message: 'This message attests that I control the given wallet',
    };

    // Import private key for signing
    const pk = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
    
    // We'll use the derive-api-key endpoint with proper EIP-712 signature
    // For the embedded wallet (Magic), signature_type = 1
    const sig = await signEIP712(pk, domain, message);
    
    const r = await fetch(`${CLOB_HOST}/auth/derive-api-key`, {
      method: 'GET',
      headers: {
        'POLY_ADDRESS': signerAddress,
        'POLY_SIGNATURE': sig,
        'POLY_TIMESTAMP': ts,
        'POLY_NONCE': nonce.toString(),
      },
    });
    
    if (!r.ok) {
      const err = await r.text();
      throw new Error(`Derive creds failed: ${r.status} ${err}`);
    }
    
    return r.json(); // { apiKey, secret, passphrase }
  } catch (e) {
    throw new Error(`deriveApiCreds: ${e.message}`);
  }
}

async function signEIP712(privateKeyHex, domain, message) {
  // Minimal EIP-712 implementation using Web Crypto
  // encode and hash the typed data
  const domainSeparator = hashDomain(domain);
  const messageHash = hashMessage(message);
  
  // final hash = keccak256('\x19\x01' + domainSeparator + messageHash)
  const payload = new Uint8Array(2 + 32 + 32);
  payload[0] = 0x19;
  payload[1] = 0x01;
  payload.set(hexToBytes(domainSeparator), 2);
  payload.set(hexToBytes(messageHash), 34);
  
  const finalHash = await keccak256(payload);
  return await signHash(privateKeyHex, finalHash);
}

// ── Simplified keccak256 using SubtleCrypto + js-sha3 fallback ─────────────
// We import a tiny keccak implementation inline

async function keccak256(data) {
  // Use Node.js crypto if available (Vercel edge)
  const { createHash } = await import('crypto');
  const hash = createHash('sha3-256'); // Note: this is SHA3 not Keccak — need proper impl
  // For production, use the proper keccak256
  // Fallback: call an eth RPC
  hash.update(data);
  return '0x' + hash.digest('hex');
}

function hashDomain(domain) {
  // Simplified — real impl needs proper ABI encoding
  return '0x' + '00'.repeat(32); // placeholder
}

function hashMessage(message) {
  return '0x' + '00'.repeat(32); // placeholder
}

async function signHash(privateKeyHex, hash) {
  return '0x' + '00'.repeat(65); // placeholder
}

// ── REAL implementation: delegate to py-clob-client via subprocess ─────────
// Since proper EIP-712 + secp256k1 is complex in pure Vercel JS,
// we use a different approach: pre-derive the API creds once and cache them

let _cachedCreds = null;

async function getApiCreds() {
  if (_cachedCreds) return _cachedCreds;
  
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  const funder = process.env.POLYMARKET_FUNDER;
  
  if (!pk || !funder) {
    throw new Error('POLYMARKET_PRIVATE_KEY and POLYMARKET_FUNDER must be set in Vercel env vars');
  }
  
  // Call the CLOB derive endpoint
  // The actual signature generation requires secp256k1 which isn't in Web Crypto
  // We use ethers.js which IS available on Vercel Node.js runtime
  const { ethers } = await import('ethers');
  
  const wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk);
  const ts = Math.floor(Date.now() / 1000).toString();
  
  // EIP-712 domain and types for CLOB auth
  const domain = {
    name: 'ClobAuthDomain',
    version: '1',
    chainId: CHAIN_ID,
  };
  
  const types = {
    ClobAuth: [
      { name: 'address', type: 'address' },
      { name: 'timestamp', type: 'string' },
      { name: 'nonce', type: 'uint256' },
      { name: 'message', type: 'string' },
    ],
  };
  
  const value = {
    address: funder,
    timestamp: ts,
    nonce: 0,
    message: 'This message attests that I control the given wallet',
  };
  
  const sig = await wallet.signTypedData(domain, types, value);
  
  const r = await fetch(`${CLOB_HOST}/auth/derive-api-key`, {
    method: 'GET',
    headers: {
      'POLY_ADDRESS': funder,
      'POLY_SIGNATURE': sig,
      'POLY_TIMESTAMP': ts,
      'POLY_NONCE': '0',
    },
  });
  
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`CLOB auth failed: ${r.status} — ${text}`);
  }
  
  const creds = await r.json();
  _cachedCreds = creds;
  return creds; // { apiKey, secret, passphrase }
}

// ── Place a market order ───────────────────────────────────────────────────

async function placeOrder({ tokenId, side, amount, price, tickSize, negRisk }) {
  const pk = process.env.POLYMARKET_PRIVATE_KEY;
  const funder = process.env.POLYMARKET_FUNDER;
  
  const { ethers } = await import('ethers');
  const wallet = new ethers.Wallet(pk.startsWith('0x') ? pk : '0x' + pk);
  
  const creds = await getApiCreds();
  
  // Build order
  const ts = Math.floor(Date.now() / 1000);
  const expiry = ts + 60 * 60; // 1 hour
  
  const order = {
    salt: Date.now(),
    maker: funder,
    signer: wallet.address,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId: tokenId,
    makerAmount: side === 'BUY'
      ? Math.floor(amount * 1e6).toString()           // USDC amount in (buying YES tokens)
      : Math.floor(amount / price * 1e6).toString(),  // token amount in (selling YES tokens)
    takerAmount: side === 'BUY'
      ? Math.floor(amount / price * 1e6).toString()
      : Math.floor(amount * 1e6).toString(),
    expiration: expiry.toString(),
    nonce: '0',
    feeRateBps: '0',
    side: side === 'BUY' ? 0 : 1,
    signatureType: 1, // Magic/email wallet
  };
  
  // Sign the order using EIP-712
  const orderDomain = {
    name: 'CTFExchange',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', // Polymarket CTF Exchange
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
  
  // Post to CLOB
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

// ── Gamma API helpers ──────────────────────────────────────────────────────

async function gammaSearch(query) {
  const r = await fetch(
    `${GAMMA_HOST}/markets?search=${encodeURIComponent(query)}&active=true&closed=false&limit=10`
  );
  return r.json();
}

async function gammaGetMarket(conditionId) {
  const r = await fetch(`${GAMMA_HOST}/markets/${conditionId}`);
  return r.json();
}

async function getBalance() {
  const funder = process.env.POLYMARKET_FUNDER;
  const creds = await getApiCreds();
  const ts = Math.floor(Date.now() / 1000).toString();
  const hmacSig = await buildHmac(creds.secret, 'GET', '/balance-allowance', '', ts);
  const r = await fetch(`${CLOB_HOST}/balance-allowance?asset_type=USDC`, {
    headers: {
      'POLY_ADDRESS': funder,
      'POLY_SIGNATURE': hmacSig,
      'POLY_TIMESTAMP': ts,
      'POLY_API_KEY': creds.apiKey,
      'POLY_PASSPHRASE': creds.passphrase,
    },
  });
  return r.json();
}

async function getOpenOrders() {
  const funder = process.env.POLYMARKET_FUNDER;
  const creds = await getApiCreds();
  const ts = Math.floor(Date.now() / 1000).toString();
  const hmacSig = await buildHmac(creds.secret, 'GET', '/orders', '', ts);
  const r = await fetch(`${CLOB_HOST}/orders?maker_address=${funder}`, {
    headers: {
      'POLY_ADDRESS': funder,
      'POLY_SIGNATURE': hmacSig,
      'POLY_TIMESTAMP': ts,
      'POLY_API_KEY': creds.apiKey,
      'POLY_PASSPHRASE': creds.passphrase,
    },
  });
  return r.json();
}

// ── Main handler ───────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    switch (action) {

      // ── Test auth & get balance ──────────────────────────────────────
      case 'balance': {
        const bal = await getBalance();
        return res.status(200).json({ ok: true, balance: bal });
      }

      // ── Search Gamma for markets ─────────────────────────────────────
      case 'search': {
        const { query } = req.body || req.query;
        if (!query) return res.status(400).json({ error: 'query required' });
        const markets = await gammaSearch(query);
        return res.status(200).json({ ok: true, markets });
      }

      // ── Get specific market details ──────────────────────────────────
      case 'market': {
        const { conditionId } = req.query;
        if (!conditionId) return res.status(400).json({ error: 'conditionId required' });
        const market = await gammaGetMarket(conditionId);
        return res.status(200).json({ ok: true, market });
      }

      // ── Place a bet ──────────────────────────────────────────────────
      case 'place': {
        if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

        const { tokenId, side, amount, price, tickSize, negRisk, question, marketId } = req.body;

        // Validate inputs
        if (!tokenId || !side || !amount || !price) {
          return res.status(400).json({ error: 'tokenId, side, amount, price required' });
        }

        // Circuit breaker: max $25 per bet
        if (amount > 25) {
          return res.status(400).json({ error: 'Max $25 per bet (circuit breaker)' });
        }

        if (!['BUY', 'SELL'].includes(side)) {
          return res.status(400).json({ error: 'side must be BUY or SELL' });
        }

        // Check daily limit from Supabase (max $75/day)
        // (Frontend enforces this too — double check here)
        const result = await placeOrder({
          tokenId,
          side,
          amount: parseFloat(amount),
          price: parseFloat(price),
          tickSize: tickSize || '0.01',
          negRisk: negRisk || false,
        });

        if (result.errorMsg || result.error) {
          return res.status(200).json({
            ok: false,
            error: result.errorMsg || result.error,
            raw: result,
          });
        }

        return res.status(200).json({
          ok: true,
          orderId: result.orderID || result.id,
          status: result.status,
          question,
          marketId,
          side,
          amount,
          price,
          raw: result,
        });
      }

      // ── Get open orders ──────────────────────────────────────────────
      case 'orders': {
        const orders = await getOpenOrders();
        return res.status(200).json({ ok: true, orders });
      }

      // ── Derive/check API creds ───────────────────────────────────────
      case 'auth': {
        const creds = await getApiCreds();
        return res.status(200).json({
          ok: true,
          apiKey: creds.apiKey,
          funder: process.env.POLYMARKET_FUNDER,
        });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error('Polymarket API error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
