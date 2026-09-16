const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');

const store = require('./store');
const cin7 = require('./cin7');
const lossesCache = require('./lossesCache');

const app = express();
const PORT = process.env.PORT || 3000;
const STOCK_LOSS_DAYS = Math.min(Number(process.env.STOCK_LOSS_DAYS) || 180, cin7.MAX_LOOKBACK_DAYS);
const CACHE_TTL_MS = 15 * 60 * 1000;
const RELAY_TOKEN = process.env.RELAY_TOKEN || null;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Kanban tasks ----

app.get('/api/tasks', (req, res) => {
  res.json({ tasks: store.listTasks() });
});

app.post('/api/tasks', async (req, res) => {
  const { title, addedBy } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  const task = await store.addTask({ title, addedBy });
  res.status(201).json({ task });
});

app.patch('/api/tasks/:id', async (req, res) => {
  const { status } = req.body || {};
  try {
    const task = await store.updateTaskStatus(req.params.id, status);
    if (!task) return res.status(404).json({ error: 'not found' });
    res.json({ task });
  } catch (err) {
    if (err.code === 'invalid_status') {
      return res.status(400).json({ error: 'status must be one of todo, doing, done' });
    }
    throw err;
  }
});

app.delete('/api/tasks/:id', async (req, res) => {
  const removed = await store.deleteTask(req.params.id);
  if (!removed) return res.status(404).json({ error: 'not found' });
  res.status(204).end();
});

// ---- Stock take losses (Cin7 Core) ----
//
// Two ways this data gets here:
// 1. Direct: this instance has CIN7_ACCOUNT_ID/CIN7_APPLICATION_KEY and can
//    reach Cin7 Core itself (e.g. running locally/on-network).
// 2. Relayed: this instance can't reach Cin7 Core directly (e.g. Cin7 blocks
//    this host's network), so a trusted machine that CAN reach it pushes
//    results here via POST /api/stock-losses/push, authenticated by
//    RELAY_TOKEN. See README for the relay script.
// Whichever supplies it, the result is persisted to disk so a restart
// doesn't lose it before the next fetch/push.

let cache = { data: lossesCache.read(), fetchedAt: 0, pending: null };
if (cache.data) cache.fetchedAt = new Date(cache.data.generatedAt).getTime() || Date.now();

async function getLosses(force) {
  const fresh = cache.data && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (fresh && !force) return cache.data;
  if (cache.pending) return cache.pending;

  cache.pending = cin7
    .fetchRecentStockLosses({ days: STOCK_LOSS_DAYS })
    .then((data) => {
      cache = { data, fetchedAt: Date.now(), pending: null };
      lossesCache.write(data);
      return data;
    })
    .catch((err) => {
      cache.pending = null;
      throw err;
    });

  return cache.pending;
}

app.get('/api/stock-losses', async (req, res) => {
  if (cin7.isConfigured()) {
    try {
      const data = await getLosses(false);
      return res.json({ configured: true, days: STOCK_LOSS_DAYS, ...data });
    } catch (err) {
      logCin7Error('fetch', err);
      return res.status(502).json({ configured: true, error: 'Could not reach Cin7 Core', days: STOCK_LOSS_DAYS });
    }
  }

  if (cache.data) {
    return res.json({ configured: true, relayed: true, days: STOCK_LOSS_DAYS, ...cache.data });
  }

  res.json({ configured: false, totalLoss: 0, entries: [], days: STOCK_LOSS_DAYS });
});

app.post('/api/stock-losses/refresh', async (req, res) => {
  if (cin7.isConfigured()) {
    try {
      const data = await getLosses(true);
      return res.json({ configured: true, days: STOCK_LOSS_DAYS, ...data });
    } catch (err) {
      logCin7Error('refresh', err);
      return res.status(502).json({ configured: true, error: 'Could not reach Cin7 Core', days: STOCK_LOSS_DAYS });
    }
  }

  if (cache.data) {
    return res.json({ configured: true, relayed: true, days: STOCK_LOSS_DAYS, ...cache.data });
  }

  res.json({ configured: false, totalLoss: 0, entries: [], days: STOCK_LOSS_DAYS });
});

app.post('/api/stock-losses/push', (req, res) => {
  if (!RELAY_TOKEN) return res.status(404).end();

  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== RELAY_TOKEN) return res.status(401).json({ error: 'invalid token' });

  const data = req.body;
  if (!data || typeof data.totalLoss !== 'number' || !Array.isArray(data.entries)) {
    return res.status(400).json({ error: 'malformed payload' });
  }

  cache = { data, fetchedAt: Date.now(), pending: null };
  lossesCache.write(data);
  console.log(`[relay] received push: $${data.totalLoss} across ${data.entries.length} entries`);
  res.status(204).end();
});

function logCin7Error(label, err) {
  const status = err.response?.status;
  const body = err.response?.data;
  console.error(
    `Cin7 ${label} failed: status=${status ?? 'n/a'} message=${err.message} body=${
      typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body)?.slice(0, 500)
    }`
  );
}

app.listen(PORT, () => {
  console.log(`Team dashboard running at http://localhost:${PORT}`);
});
