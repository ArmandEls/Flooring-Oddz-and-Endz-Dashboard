// Runs on a machine that CAN reach Cin7 Core (this one), fetches the recent
// stock-take losses, and pushes the result to the deployed dashboard.
// Needed because Cin7 Core blocks requests from Render's network directly
// (see README: "Cin7 blocked on the deployed host").
//
// Usage: node scripts/push-losses.js
// Intended to be run on a schedule (see README for the Windows Task
// Scheduler setup) — it fetches once, pushes once, and exits.

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const axios = require('axios');
const cin7 = require('../server/cin7');

const DASHBOARD_URL = process.env.DASHBOARD_URL;
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const STOCK_LOSS_DAYS = Math.min(Number(process.env.STOCK_LOSS_DAYS) || 180, cin7.MAX_LOOKBACK_DAYS);

async function main() {
  if (!DASHBOARD_URL || !RELAY_TOKEN) {
    console.error('DASHBOARD_URL and RELAY_TOKEN must be set in .env to run the relay.');
    process.exit(1);
  }
  if (!cin7.isConfigured()) {
    console.error('CIN7_ACCOUNT_ID / CIN7_APPLICATION_KEY must be set in .env to run the relay.');
    process.exit(1);
  }

  console.log(`[relay] fetching losses from Cin7 Core (last ${STOCK_LOSS_DAYS} days)...`);
  const data = await cin7.fetchRecentStockLosses({ days: STOCK_LOSS_DAYS });
  console.log(`[relay] fetched: $${data.totalLoss} across ${data.entries.length} entries`);

  await axios.post(`${DASHBOARD_URL.replace(/\/$/, '')}/api/stock-losses/push`, data, {
    headers: { Authorization: `Bearer ${RELAY_TOKEN}` },
    timeout: 15000,
  });
  console.log('[relay] pushed to dashboard successfully.');
}

main().catch((err) => {
  console.error('[relay] failed:', err.response?.data || err.message);
  process.exit(1);
});
