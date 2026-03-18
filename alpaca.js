const https = require('https');
const http = require('http');
const { URL } = require('url');

const API_KEY = process.env.ALPACA_API_KEY || '';
const SECRET_KEY = process.env.ALPACA_SECRET_KEY || '';
const BASE_URL = process.env.ALPACA_BASE_URL || 'https://data.alpaca.markets';
const FEED = process.env.ALPACA_FEED || 'iex'; // 'iex' (free) or 'sip' (paid)

function isConfigured() {
  return !!(API_KEY && SECRET_KEY);
}

function request(urlPath, params = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url.toString(), {
      headers: {
        'APCA-API-KEY-ID': API_KEY,
        'APCA-API-SECRET-KEY': SECRET_KEY,
        'Accept': 'application/json',
      },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`Alpaca ${res.statusCode}: ${body}`));
        } else {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`Alpaca parse error: ${body.slice(0, 200)}`)); }
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Alpaca request timeout')); });
  });
}

async function getSnapshots(symbols) {
  if (!isConfigured()) throw new Error('ALPACA_NOT_CONFIGURED');
  return request('/v2/stocks/snapshots', {
    symbols: symbols.join(','),
    feed: FEED,
  });
}

async function getBars(symbol, timeframe = '1Day', limit = 60) {
  if (!isConfigured()) throw new Error('ALPACA_NOT_CONFIGURED');
  // Alpaca requires a start date for bars
  const daysBack = timeframe === '1Day' ? Math.max(limit * 2, 90) : 30;
  const start = new Date(Date.now() - daysBack * 86400000).toISOString().split('T')[0];
  const result = await request('/v2/stocks/bars', {
    symbols: symbol,
    timeframe,
    start,
    limit: String(limit),
    feed: FEED,
  });
  return result;
}

function formatQuote(symbol, snapshot) {
  if (!snapshot) return null;
  const q = snapshot.latestTrade || snapshot.minuteBar || {};
  const daily = snapshot.dailyBar || {};
  const prevDaily = snapshot.prevDailyBar || {};
  const price = q.p || daily.c || 0;
  const prevClose = prevDaily.c || 0;
  const change = prevClose ? price - prevClose : 0;
  const changePercent = prevClose ? ((change / prevClose) * 100) : 0;

  return {
    symbol,
    price: parseFloat(price.toFixed(2)),
    prevClose: parseFloat(prevClose.toFixed(2)),
    change: parseFloat(change.toFixed(2)),
    changePercent: parseFloat(changePercent.toFixed(2)),
    volume: daily.v || 0,
    high: daily.h || 0,
    low: daily.l || 0,
    open: daily.o || 0,
    timestamp: q.t || daily.t || null,
  };
}

function formatSnapshot(symbol, snapshot) {
  if (!snapshot) return null;
  return {
    symbol,
    quote: formatQuote(symbol, snapshot),
    dailyBar: snapshot.dailyBar || null,
    minuteBar: snapshot.minuteBar || null,
    prevDailyBar: snapshot.prevDailyBar || null,
    latestTrade: snapshot.latestTrade || null,
  };
}

module.exports = { isConfigured, getSnapshots, getBars, formatQuote, formatSnapshot };
