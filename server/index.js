const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');

const store = require('./store');
const cin7 = require('./cin7');

const app = express();
const PORT = process.env.PORT || 3000;
const STOCK_LOSS_DAYS = Math.min(Number(process.env.STOCK_LOSS_DAYS) || 180, cin7.MAX_LOOKBACK_DAYS);
const CACHE_TTL_MS = 15 * 60 * 1000;

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

let cache = { data: null, fetchedAt: 0, pending: null };

async function getLosses(force) {
  const fresh = cache.data && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (fresh && !force) return cache.data;
  if (cache.pending) return cache.pending;

  cache.pending = cin7
    .fetchRecentStockLosses({ days: STOCK_LOSS_DAYS })
    .then((data) => {
      cache = { data, fetchedAt: Date.now(), pending: null };
      return data;
    })
    .catch((err) => {
      cache.pending = null;
      throw err;
    });

  return cache.pending;
}

app.get('/api/stock-losses', async (req, res) => {
  if (!cin7.isConfigured()) {
    return res.json({ configured: false, totalLoss: 0, entries: [], days: STOCK_LOSS_DAYS });
  }
  try {
    const data = await getLosses(false);
    res.json({ configured: true, days: STOCK_LOSS_DAYS, ...data });
  } catch (err) {
    console.error('Cin7 fetch failed:', err.message);
    res.status(502).json({ configured: true, error: 'Could not reach Cin7 Core', days: STOCK_LOSS_DAYS });
  }
});

app.post('/api/stock-losses/refresh', async (req, res) => {
  if (!cin7.isConfigured()) {
    return res.json({ configured: false, totalLoss: 0, entries: [], days: STOCK_LOSS_DAYS });
  }
  try {
    const data = await getLosses(true);
    res.json({ configured: true, days: STOCK_LOSS_DAYS, ...data });
  } catch (err) {
    console.error('Cin7 refresh failed:', err.message);
    res.status(502).json({ configured: true, error: 'Could not reach Cin7 Core', days: STOCK_LOSS_DAYS });
  }
});

app.listen(PORT, () => {
  console.log(`Team dashboard running at http://localhost:${PORT}`);
});
