const https = require('https');

const FUTURES_MAP = {
  'ES': 'ES=F',   // S&P 500 E-mini
  'NQ': 'NQ=F',   // Nasdaq 100 E-mini
  'YM': 'YM=F',   // Dow E-mini
  'CL': 'CL=F',   // Crude Oil
  'GC': 'GC=F',   // Gold
  '10Y': '^TNX',  // 10-Year Treasury Yield
};

const CNBC_SYMBOLS = '@ES.1|@NQ.1|@YM.1|@CL.1|@GC.1';

function fetchJson(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      timeout,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        } else {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`Parse error: ${body.slice(0, 200)}`)); }
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

async function getFuturesFromYahoo() {
  const results = {};
  const symbols = Object.entries(FUTURES_MAP);

  await Promise.allSettled(symbols.map(async ([name, yahooSymbol]) => {
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=5m`;
      const data = await fetchJson(url);
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta) {
        const price = meta.regularMarketPrice || 0;
        const prevClose = meta.previousClose || meta.chartPreviousClose || 0;
        const change = prevClose ? price - prevClose : 0;
        const changePercent = prevClose ? ((change / prevClose) * 100) : 0;
        results[name] = {
          symbol: name,
          name: getDisplayName(name),
          price: parseFloat(price.toFixed(2)),
          prevClose: parseFloat(prevClose.toFixed(2)),
          change: parseFloat(change.toFixed(2)),
          changePercent: parseFloat(changePercent.toFixed(2)),
          source: 'yahoo',
        };
      }
    } catch (e) {
      // Will try CNBC fallback
    }
  }));

  return results;
}

async function getFuturesFromCNBC() {
  const results = {};
  try {
    const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${CNBC_SYMBOLS}&requestMethod=itv&no498s=1&partnerId=2&fund=1&exthrs=1&output=json`;
    const data = await fetchJson(url);
    const quotes = data?.FormattedQuoteResult?.FormattedQuote || [];

    const cnbcToName = {
      '@ES.1': 'ES', '@NQ.1': 'NQ', '@YM.1': 'YM', '@CL.1': 'CL', '@GC.1': 'GC',
    };

    for (const q of quotes) {
      const name = cnbcToName[q.symbol];
      if (!name) continue;
      const price = parseFloat(q.last) || 0;
      const change = parseFloat(q.change) || 0;
      const changePercent = parseFloat(q.change_pct) || 0;
      results[name] = {
        symbol: name,
        name: getDisplayName(name),
        price,
        prevClose: parseFloat((price - change).toFixed(2)),
        change: parseFloat(change.toFixed(2)),
        changePercent: parseFloat(changePercent.toFixed(2)),
        source: 'cnbc',
      };
    }
  } catch (e) {
    // CNBC failed
  }
  return results;
}

async function getFutures() {
  // Try Yahoo first, fill gaps with CNBC
  let results = await getFuturesFromYahoo();
  const missing = Object.keys(FUTURES_MAP).filter(k => !results[k]);

  if (missing.length > 0) {
    const cnbc = await getFuturesFromCNBC();
    for (const k of missing) {
      if (cnbc[k]) results[k] = cnbc[k];
    }
  }

  return results;
}

async function getFundamentals(symbol) {
  // Use Yahoo v8 chart endpoint (no crumb needed) + v6 quote for fundamentals
  const result = { symbol, source: 'yahoo' };

  // v6 finance quote endpoint (no auth/crumb needed)
  try {
    const url = `https://query1.finance.yahoo.com/v6/finance/quote?symbols=${encodeURIComponent(symbol)}`;
    const data = await fetchJson(url);
    const q = data?.quoteResponse?.result?.[0];
    if (q) {
      result.pe = q.forwardPE || q.trailingPE || null;
      result.eps = q.trailingAnnualDividendRate || q.epsTrailingTwelveMonths || null;
      result.marketCap = q.marketCap || null;
      result.marketCapFmt = q.marketCap ? formatMarketCap(q.marketCap) : null;
      result.targetMeanPrice = q.targetMeanPrice || null;
      result.targetHighPrice = q.targetHighPrice || null;
      result.targetLowPrice = q.targetLowPrice || null;
      result.numberOfAnalysts = q.numberOfAnalystOpinions || null;
      result.recommendation = q.recommendationKey || null;
      result.earningsDate = q.earningsTimestamp ? new Date(q.earningsTimestamp * 1000).toISOString().split('T')[0] : null;
      result.dividendYield = q.dividendYield || null;
      result.beta = q.beta || null;
      result.fiftyTwoWeekHigh = q.fiftyTwoWeekHigh || null;
      result.fiftyTwoWeekLow = q.fiftyTwoWeekLow || null;
    }
  } catch (e1) {
    // Try v8 chart endpoint as fallback
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
      const data = await fetchJson(url);
      const meta = data?.chart?.result?.[0]?.meta;
      if (meta) {
        result.pe = null;
        result.fiftyTwoWeekHigh = meta.fiftyTwoWeekHigh || null;
        result.fiftyTwoWeekLow = meta.fiftyTwoWeekLow || null;
      }
    } catch (e2) {
      throw new Error(`No fundamentals data for ${symbol}: ${e1.message}`);
    }
  }

  return result;
}

function formatMarketCap(n) {
  if (n >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  return String(n);
}

function getDisplayName(symbol) {
  const names = {
    'ES': 'S&P 500 Futures',
    'NQ': 'Nasdaq 100 Futures',
    'YM': 'Dow Futures',
    'CL': 'Crude Oil',
    'GC': 'Gold',
    '10Y': '10-Year Treasury',
  };
  return names[symbol] || symbol;
}

module.exports = { getFutures, getFundamentals };
