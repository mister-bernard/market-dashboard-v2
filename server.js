require('dotenv').config();
const express = require('express');
const cache = require('./cache');
const alpaca = require('./alpaca');
const yahoo = require('./yahoo');

const PORT = parseInt(process.env.PORT || '3010', 10);
// Comma-separated list of additional allowed CORS origins (e.g. your frontend host).
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = [
  'https://ambermlysak.github.io',
  ...EXTRA_ORIGINS,
];

const app = express();

// Trust proxy for rate limiting behind reverse proxy
app.set('trust proxy', 1);

// ── CORS ──
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Rate Limiting (200 req/min per IP) ──
const rateLimits = new Map();
setInterval(() => rateLimits.clear(), 60_000);

app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const count = (rateLimits.get(ip) || 0) + 1;
  rateLimits.set(ip, count);
  if (count > 200) {
    return res.status(429).json({ error: 'Rate limit exceeded (200/min)' });
  }
  next();
});

// ── Request Logging ──
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    console.log(`${new Date().toISOString()} ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// ── Helper: respond with cache fallback ──
function withCacheFallback(cacheKey, ttl, fetchFn) {
  return async (req, res) => {
    try {
      const cached = cache.get(cacheKey);
      if (cached && !cached.stale) {
        return res.json({ data: cached.data, cached: true });
      }

      const data = await fetchFn(req);
      cache.set(cacheKey, data, ttl);
      return res.json({ data, cached: false });
    } catch (err) {
      // If Alpaca not configured or fetch failed, return stale cache if available
      const stale = cache.get(cacheKey);
      if (stale) {
        return res.json({ data: stale.data, cached: true, stale: true, warning: err.message });
      }

      if (err.message === 'ALPACA_NOT_CONFIGURED') {
        return res.status(503).json({
          error: 'Alpaca API keys not configured',
          hint: 'Set ALPACA_API_KEY and ALPACA_SECRET_KEY environment variables',
        });
      }
      console.error(`Error: ${err.message}`);
      return res.status(502).json({ error: 'Upstream fetch failed', message: err.message });
    }
  };
}

// ── Health ──
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    alpacaConfigured: alpaca.isConfigured(),
    timestamp: new Date().toISOString(),
  });
});

// ── Quotes ──
app.get('/api/quotes', (req, res, next) => {
  const symbols = (req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: 'symbols parameter required' });
  if (symbols.length > 50) return res.status(400).json({ error: 'Max 50 symbols per request' });

  const cacheKey = `quotes:${symbols.sort().join(',')}`;
  withCacheFallback(cacheKey, 5, async () => {
    const snapshots = await alpaca.getSnapshots(symbols);
    const quotes = {};
    for (const sym of symbols) {
      quotes[sym] = alpaca.formatQuote(sym, snapshots[sym]) || { symbol: sym, error: 'No data' };
    }
    return quotes;
  })(req, res, next);
});

// ── Bars ──
app.get('/api/bars', (req, res, next) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  const timeframe = req.query.timeframe || '1Day';
  const limit = Math.min(parseInt(req.query.limit || '60', 10), 1000);
  if (!symbol) return res.status(400).json({ error: 'symbol parameter required' });

  const cacheKey = `bars:${symbol}:${timeframe}:${limit}`;
  withCacheFallback(cacheKey, 60, async () => {
    const result = await alpaca.getBars(symbol, timeframe, limit);
    return result.bars?.[symbol] || result[symbol] || [];
  })(req, res, next);
});

// ── Snapshots ──
app.get('/api/snapshot', (req, res, next) => {
  const symbols = (req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  if (!symbols.length) return res.status(400).json({ error: 'symbols parameter required' });
  if (symbols.length > 50) return res.status(400).json({ error: 'Max 50 symbols per request' });

  const cacheKey = `snapshot:${symbols.sort().join(',')}`;
  withCacheFallback(cacheKey, 5, async () => {
    const snapshots = await alpaca.getSnapshots(symbols);
    const result = {};
    for (const sym of symbols) {
      result[sym] = alpaca.formatSnapshot(sym, snapshots[sym]) || { symbol: sym, error: 'No data' };
    }
    return result;
  })(req, res, next);
});

// ── Fundamentals (Yahoo Finance) ──
app.get('/api/fundamentals', (req, res, next) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'symbol parameter required' });

  const cacheKey = `fundamentals:${symbol}`;
  withCacheFallback(cacheKey, 3600, async () => {
    return await yahoo.getFundamentals(symbol);
  })(req, res, next);
});

// ── Futures ──
app.get('/api/futures', (req, res, next) => {
  const cacheKey = 'futures:all';
  withCacheFallback(cacheKey, 30, async () => {
    return await yahoo.getFutures();
  })(req, res, next);
});

// ── 404 ──
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Start ──
const server = app.listen(PORT, () => {
  console.log(`Market proxy server listening on port ${PORT}`);
  console.log(`Alpaca configured: ${alpaca.isConfigured()}`);
  console.log(`Alpaca feed: ${process.env.ALPACA_FEED || 'iex'}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    cache.close();
    process.exit(0);
  });
});
process.on('SIGINT', () => {
  server.close(() => {
    cache.close();
    process.exit(0);
  });
});
