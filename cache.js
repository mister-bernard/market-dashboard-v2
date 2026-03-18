// In-memory cache with TTL (no native dependencies)
const store = new Map();

function get(key) {
  const entry = store.get(key);
  if (!entry) return null;
  const age = (Date.now() - entry.ts) / 1000;
  return { data: entry.data, age, expired: age > entry.ttl };
}

function set(key, data, ttlSeconds) {
  store.set(key, { data, ts: Date.now(), ttl: ttlSeconds });
  // Prune if store gets too big
  if (store.size > 5000) {
    const now = Date.now();
    for (const [k, v] of store) {
      if ((now - v.ts) / 1000 > v.ttl * 3) store.delete(k);
    }
  }
}

module.exports = { get, set };
