const axios = require('axios');

const BASE_URL = 'https://inventory.dearsystems.com/ExternalApi/v2';
const PAGE_SIZE = 100;
// Safety ceiling only — comfortably above the volume this account has shown
// even over a 180-day window (~440), so nothing in a 2-month window gets
// silently dropped; "truncated" only fires if volume genuinely exceeds this.
const MAX_DETAIL_FETCHES = 600;
// Cin7 Core enforces a fairly strict per-account rate limit; stay well under
// it (roughly 1 request/sec) and back off hard whenever it replies 429.
const REQUEST_SPACING_MS = 1000;
const MAX_RETRIES = 5;
const MAX_LOOKBACK_DAYS = 60; // never look back more than 2 months
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const WORST_SKUS_LIMIT = 8;
const STATE_PRODUCTS_LIMIT = 8;
const OTHER_STATE = 'Other';

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
// Hand". Negative amounts are inventory written DOWN (a loss); positive
// amounts are stock added/corrected up (a gain). We track both sides so the
// dashboard can show the net effect, not just the loss side.
function lossAndGainFromTransactions(transactions) {
  if (!Array.isArray(transactions)) return { loss: 0, gain: 0 };
  let loss = 0;
  let gain = 0;
  for (const t of transactions) {
    const amount = Number(t.Amount);
    if (!Number.isFinite(amount)) continue;
    if (amount < 0) loss -= amount;
    else gain += amount;
  }
  return { loss, gain };
}

function lineItemsFor(detail) {
  return (detail.ExistingStockLines || []).length ? detail.ExistingStockLines : detail.NewStockLines || [];
}

// Maps this account's actual Cin7 Location names to the three states the
// business cares about. Confirmed with the account owner:
// - "Main Warehouse" (the default, used for nearly all stock takes) and
//   "Perth Holding Warehouse" are both Perth.
// - "Melbourne" and "Back Orders Melbourne" are both Melbourne.
// - "Adelaide Warehouse" is Adelaide.
// - Anything else (e.g. the generic "Backorders", or no location) is Other.
function stateForLocationName(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('melbourne')) return 'Melbourne';
  if (n.includes('adelaide')) return 'Adelaide';
  if (n.includes('perth')) return 'Perth';
  if (n.includes('main warehouse')) return 'Perth';
  return OTHER_STATE;
}

// Groups line items by state, so a stock take's loss can be split first
// across the states it touched, then across the specific products at each
// state — rather than splitting evenly across every line regardless of
// which state it belongs to.
function groupLinesByState(lines) {
  const groups = new Map();
  for (const line of lines) {
    const state = stateForLocationName(line.Location);
    if (!groups.has(state)) groups.set(state, []);
    groups.get(state).push(line);
  }
  if (groups.size === 0) groups.set(OTHER_STATE, []);
  return groups;
}

// SKU/ProductName are already present on each line item in the detail
// response, so attributing loss to products needs no extra API calls — just
// split the given amount evenly across the products in `lines`.
function addToSkuTotals(skuTotals, lines, amount) {
  if (lines.length === 0) return;
  const share = amount / lines.length;
  for (const line of lines) {
    const sku = line.SKU || line.ProductID || 'Unknown';
    const existing = skuTotals.get(sku);
    if (existing) {
      existing.amount += share;
    } else {
      skuTotals.set(sku, { sku, productName: line.ProductName || sku, amount: share });
    }
  }
}

async function fetchRecentStockLosses({ days = MAX_LOOKBACK_DAYS } = {}) {
  const http = getClient();
  if (!http) {
    const err = new Error('Cin7 Core credentials are not configured');
    err.code = 'cin7_not_configured';
    throw err;
  }

  const clampedDays = Math.min(days, MAX_LOOKBACK_DAYS);
  const now = Date.now();
  const cutoffMs = now - clampedDays * 24 * 60 * 60 * 1000;
  const weekCutoffMs = now - WEEK_MS;

  const countResp = await getWithRetry(http, '/stockadjustmentList', {
    Page: 1,
    Limit: 1,
    Status: 'COMPLETED',
  });
  const total = countResp.data.Total || 0;
  if (total === 0) {
    return {
      totalLoss: 0,
      totalGain: 0,
      netAmount: 0,
      entries: [],
      locationTotals: [],
      stateProducts: [],
      worstSkusThisWeek: [],
      weeklyLoss: 0,
      weeklyGain: 0,
      weeklyNetAmount: 0,
      weeklyLocationTotals: [],
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
  console.log(
    `[cin7] stock-losses scan: ${candidates.length} stock take numbers in the ${clampedDays}-day window, fetching all ${toFetch.length}`
  );

  const entries = [];
  const locationTotals = new Map();
  const weeklyLocationTotals = new Map();
  const stateProductTotals = new Map(); // state -> Map<sku, {sku, productName, amount}>
  const skuTotals = new Map();
  let totalLoss = 0;
  let totalGain = 0;
  let weeklyLoss = 0;
  let weeklyGain = 0;
  let processed = 0;

  for (const row of toFetch) {
    const detailResp = await getWithRetry(http, '/stockadjustment', { TaskID: row.TaskID });
    const detail = detailResp.data;
    const { loss, gain } = lossAndGainFromTransactions(detail.Transactions);
    totalLoss += loss;
    totalGain += gain;
    processed++;
    if (processed % 50 === 0) {
      console.log(`[cin7] ...${processed}/${toFetch.length} stock take numbers processed`);
    }

    const effectiveMs = new Date(row.EffectiveDate).getTime();
    const inLastWeek = Number.isFinite(effectiveMs) && effectiveMs >= weekCutoffMs;
    if (inLastWeek) {
      weeklyLoss += loss;
      weeklyGain += gain;
    }

    const lines = lineItemsFor(detail);
    let locations = [];

    // Location totals are built from the same gross loss figure shown per
    // stock take in the entries list below, so the two reconcile exactly —
    // summing "By state" equals summing the "Loss" column. The loss is
    // split first across the states a stock take touched, then — within
    // each state's share — across the specific products at that state, so
    // "which products is this state's loss coming from" stays accurate for
    // stock takes that span more than one state.
    if (loss > 0.01) {
      const stateGroups = groupLinesByState(lines);
      locations = [...stateGroups.keys()];
      const share = Math.round((loss / locations.length) * 100) / 100;
      for (const [state, stateLines] of stateGroups) {
        locationTotals.set(state, Math.round(((locationTotals.get(state) || 0) + share) * 100) / 100);
        if (inLastWeek) {
          weeklyLocationTotals.set(
            state,
            Math.round(((weeklyLocationTotals.get(state) || 0) + share) * 100) / 100
          );
        }

        if (!stateProductTotals.has(state)) stateProductTotals.set(state, new Map());
        addToSkuTotals(stateProductTotals.get(state), stateLines, share);
      }

      if (inLastWeek) {
        addToSkuTotals(skuTotals, lines, loss);
      }
    }

    if (loss <= 0.01) continue;

    entries.push({
      taskId: row.TaskID,
      stocktakeNumber: row.StocktakeNumber,
      date: row.EffectiveDate,
      reference: row.Reference || '',
      comment: detail.Comment || '',
      locations,
      lossAmount: Math.round(loss * 100) / 100,
    });
  }

  entries.sort((a, b) => new Date(b.date) - new Date(a.date));
  totalLoss = Math.round(totalLoss * 100) / 100;
  totalGain = Math.round(totalGain * 100) / 100;
  const netAmount = Math.round((totalGain - totalLoss) * 100) / 100;
  weeklyLoss = Math.round(weeklyLoss * 100) / 100;
  weeklyGain = Math.round(weeklyGain * 100) / 100;
  const weeklyNetAmount = Math.round((weeklyGain - weeklyLoss) * 100) / 100;

  const locationTotalsSorted = [...locationTotals.entries()]
    .map(([state, amount]) => ({ state, amount }))
    .sort((a, b) => b.amount - a.amount);

  const weeklyLocationTotalsSorted = [...weeklyLocationTotals.entries()]
    .map(([state, amount]) => ({ state, amount }))
    .sort((a, b) => b.amount - a.amount);

  const worstSkusThisWeek = [...skuTotals.values()]
    .map((s) => ({ ...s, amount: Math.round(s.amount * 100) / 100 }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, WORST_SKUS_LIMIT);

  // Which products each state's loss total is actually made up of, over the
  // same window as locationTotals — capped per state since a state can
  // accumulate many distinct products over 60 days.
  const stateProducts = [...stateProductTotals.entries()]
    .map(([state, skuMap]) => ({
      state,
      products: [...skuMap.values()]
        .map((s) => ({ ...s, amount: Math.round(s.amount * 100) / 100 }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, STATE_PRODUCTS_LIMIT),
    }))
    .sort((a, b) => (locationTotals.get(b.state) || 0) - (locationTotals.get(a.state) || 0));

  console.log(
    `[cin7] stock-losses scan complete: loss $${totalLoss}, gain $${totalGain}, net $${netAmount} across ${toFetch.length} stock take numbers (${entries.length} were losses)`
  );

  return {
    totalLoss,
    totalGain,
    netAmount,
    entries,
    locationTotals: locationTotalsSorted,
    stateProducts,
    worstSkusThisWeek,
    weeklyLoss,
    weeklyGain,
    weeklyNetAmount,
    weeklyLocationTotals: weeklyLocationTotalsSorted,
    truncated,
    days: clampedDays,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { isConfigured, fetchRecentStockLosses, MAX_LOOKBACK_DAYS };
