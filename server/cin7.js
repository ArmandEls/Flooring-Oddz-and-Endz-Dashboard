const axios = require('axios');

const BASE_URL = 'https://inventory.dearsystems.com/ExternalApi/v2';
const PAGE_SIZE = 100;
const MAX_DETAIL_FETCHES = 30;
// A large stock take can touch 50+ distinct products; resolving every one's
// category would mean 50+ extra API calls for a single entry. Sample a
// handful instead — real stock takes are almost always run per product
// range already, so a few products are enough to identify the category.
const MAX_PRODUCTS_PER_ENTRY = 3;
// Cin7 Core enforces a fairly strict per-account rate limit; stay well under
// it (roughly 1 request/sec) and back off hard whenever it replies 429.
const REQUEST_SPACING_MS = 1000;
const MAX_RETRIES = 5;
const MAX_LOOKBACK_DAYS = 180; // never look back more than 6 months
const UNCATEGORIZED = 'Uncategorized';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cin7 Core's rate limit is easy to trip when scanning many records. Retry
// 429s (and transient network errors) with backoff instead of failing the
// whole scan over one rate-limited call.
async function getWithRetry(http, url, params) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await sleep(REQUEST_SPACING_MS);
    try {
      return await http.get(url, { params });
    } catch (err) {
      const status = err.response?.status;
      const isLastAttempt = attempt === MAX_RETRIES;
      const retryable = status === 429 || !status; // 429, or no response (timeout/network)
      if (!retryable || isLastAttempt) throw err;

      const retryAfterHeader = Number(err.response?.headers?.['retry-after']);
      const backoffMs = Number.isFinite(retryAfterHeader)
        ? retryAfterHeader * 1000
        : REQUEST_SPACING_MS * 2 ** attempt;
      await sleep(Math.min(backoffMs, 30000));
    }
  }
  throw new Error('unreachable');
}

function getClient() {
  const accountId = process.env.CIN7_ACCOUNT_ID;
  const appKey = process.env.CIN7_APPLICATION_KEY;
  if (!accountId || !appKey) return null;
  return axios.create({
    baseURL: BASE_URL,
    headers: {
      'api-auth-accountid': accountId,
      'api-auth-applicationkey': appKey,
    },
    timeout: 15000,
  });
}

function isConfigured() {
  return getClient() !== null;
}

// A stock adjustment's Transactions carry the $ movement in/out of "Stock on
// Hand". A negative Amount is inventory being written DOWN (a loss); positive
// is stock being added. We sum only the negative side per adjustment.
function lossFromTransactions(transactions) {
  if (!Array.isArray(transactions)) return 0;
  const negatives = transactions
    .map((t) => Number(t.Amount))
    .filter((n) => Number.isFinite(n) && n < 0);
  if (negatives.length === 0) return 0;
  return -negatives.reduce((sum, n) => sum + n, 0);
}

// Cin7 doesn't expose category on the adjustment/stock-take record itself,
// only on the Product. We resolve it per product and cache lookups for the
// life of one fetchRecentStockLosses() call.
async function resolveCategory(http, productId, cache) {
  if (!productId) return UNCATEGORIZED;
  if (cache.has(productId)) return cache.get(productId);

  try {
    const resp = await getWithRetry(http, '/product', { ID: productId });
    const category = resp.data?.Products?.[0]?.Category || UNCATEGORIZED;
    cache.set(productId, category);
    return category;
  } catch {
    cache.set(productId, UNCATEGORIZED);
    return UNCATEGORIZED;
  }
}

// Distributes an adjustment's total $ loss evenly across the distinct
// categories its line items touch, so per-category totals still add up to
// the true total loss instead of double-counting mixed stock takes.
async function categorizeEntry(http, detail, productCategoryCache) {
  const lines = (detail.ExistingStockLines || []).length
    ? detail.ExistingStockLines
    : detail.NewStockLines || [];

  const allProductIds = [...new Set(lines.map((l) => l.ProductID).filter(Boolean))];
  if (allProductIds.length === 0) return [UNCATEGORIZED];

  // Prefer IDs already in cache (free) before spending API calls sampling
  // uncached ones, so warm categories don't get pushed out by the cap.
  const cached = allProductIds.filter((id) => productCategoryCache.has(id));
  const uncached = allProductIds.filter((id) => !productCategoryCache.has(id));
  const sample = [...cached, ...uncached].slice(0, Math.max(MAX_PRODUCTS_PER_ENTRY, cached.length));

  const categories = new Set();
  for (const id of sample) {
    categories.add(await resolveCategory(http, id, productCategoryCache));
  }
  return [...categories];
}

async function fetchRecentStockLosses({ days = MAX_LOOKBACK_DAYS } = {}) {
  const http = getClient();
  if (!http) {
    const err = new Error('Cin7 Core credentials are not configured');
    err.code = 'cin7_not_configured';
    throw err;
  }

  const clampedDays = Math.min(days, MAX_LOOKBACK_DAYS);
  const cutoffMs = Date.now() - clampedDays * 24 * 60 * 60 * 1000;

  const countResp = await getWithRetry(http, '/stockadjustmentList', {
    Page: 1,
    Limit: 1,
    Status: 'COMPLETED',
  });
  const total = countResp.data.Total || 0;
  if (total === 0) {
    return {
      totalLoss: 0,
      entries: [],
      categoryTotals: [],
      truncated: false,
      days: clampedDays,
      generatedAt: new Date().toISOString(),
    };
  }

  const lastPage = Math.ceil(total / PAGE_SIZE);
  const candidates = [];
  let reachedCutoff = false;

  for (let page = lastPage; page >= 1 && !reachedCutoff; page--) {
    const resp = await getWithRetry(http, '/stockadjustmentList', {
      Page: page,
      Limit: PAGE_SIZE,
      Status: 'COMPLETED',
    });
    const rows = resp.data.StockAdjustmentList || [];
    if (rows.length === 0) break;

    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const effectiveMs = new Date(row.EffectiveDate).getTime();
      if (!Number.isFinite(effectiveMs) || effectiveMs < cutoffMs) {
        reachedCutoff = true;
        break;
      }
      candidates.push(row);
    }
  }

  const truncated = candidates.length > MAX_DETAIL_FETCHES;
  const toFetch = candidates.slice(0, MAX_DETAIL_FETCHES);
  console.log(`[cin7] stock-losses scan: ${candidates.length} candidates in window, fetching details for ${toFetch.length}`);

  const productCategoryCache = new Map();
  const entries = [];
  const categoryTotals = new Map();

  for (const row of toFetch) {
    const detailResp = await getWithRetry(http, '/stockadjustment', { TaskID: row.TaskID });
    const detail = detailResp.data;
    const lossAmount = lossFromTransactions(detail.Transactions);
    if (lossAmount <= 0.01) continue;

    const categories = await categorizeEntry(http, detail, productCategoryCache);
    const share = Math.round((lossAmount / categories.length) * 100) / 100;
    for (const category of categories) {
      categoryTotals.set(category, Math.round(((categoryTotals.get(category) || 0) + share) * 100) / 100);
    }

    entries.push({
      taskId: row.TaskID,
      stocktakeNumber: row.StocktakeNumber,
      date: row.EffectiveDate,
      reference: row.Reference || '',
      comment: detail.Comment || '',
      categories,
      lossAmount: Math.round(lossAmount * 100) / 100,
    });
  }

  entries.sort((a, b) => new Date(b.date) - new Date(a.date));
  const totalLoss = Math.round(entries.reduce((sum, e) => sum + e.lossAmount, 0) * 100) / 100;
  const categoryTotalsSorted = [...categoryTotals.entries()]
    .map(([category, amount]) => ({ category, amount }))
    .sort((a, b) => b.amount - a.amount);

  console.log(`[cin7] stock-losses scan complete: $${totalLoss} across ${entries.length} entries`);

  return {
    totalLoss,
    entries,
    categoryTotals: categoryTotalsSorted,
    truncated,
    days: clampedDays,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { isConfigured, fetchRecentStockLosses, MAX_LOOKBACK_DAYS };
