// Compiles a weekly summary (stock take losses/gains + kanban board status)
// from the live dashboard's own API and emails it via SMTP. Reads from the
// dashboard rather than Cin7 directly, so it just uses whatever the relay
// most recently pushed — no separate Cin7 scan needed here.
//
// Usage: node scripts/send-weekly-report.js
// Intended to run weekly on a schedule (see README).

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const axios = require('axios');
const nodemailer = require('nodemailer');

const DASHBOARD_URL = process.env.DASHBOARD_URL;
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const REPORT_TO = process.env.REPORT_TO || SMTP_USER;
const REPORT_FROM = process.env.REPORT_FROM || SMTP_USER;

function fmtMoney(n) {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(n || 0);
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-AU');
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function fetchDashboardData() {
  const [losses, tasksResp] = await Promise.all([
    axios.get(`${DASHBOARD_URL.replace(/\/$/, '')}/api/stock-losses`).then((r) => r.data),
    axios.get(`${DASHBOARD_URL.replace(/\/$/, '')}/api/tasks`).then((r) => r.data),
  ]);
  return { losses, tasks: tasksResp.tasks || [] };
}

function summarizeBoard(tasks) {
  const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const counts = { todo: 0, doing: 0, blocked: 0, done: 0 };
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;

  const blocked = tasks.filter((t) => t.status === 'blocked');
  const completedThisWeek = tasks.filter(
    (t) => t.status === 'done' && new Date(t.updatedAt).getTime() >= weekAgoMs
  );

  return { counts, blocked, completedThisWeek };
}

function buildEmail({ losses, tasks }) {
  const board = summarizeBoard(tasks);

  const categoryLines = (losses.weeklyCategoryTotals || [])
    .map((c) => {
      const isGain = c.amount < 0;
      const amount = (isGain ? '+' : '') + fmtMoney(Math.abs(c.amount));
      return `  - ${c.category}: ${amount}${isGain ? ' (net gain)' : ''}`;
    })
    .join('\n');

  const skuLines = (losses.worstSkusThisWeek || [])
    .map((s) => `  - ${s.productName}: ${fmtMoney(s.amount)}`)
    .join('\n');

  const blockedLines = board.blocked.length
    ? board.blocked.map((t) => `  - "${t.title}" — ${t.blockedReason || 'no reason given'}`).join('\n')
    : '  (none)';

  const completedLines = board.completedThisWeek.length
    ? board.completedThisWeek.map((t) => `  - ${t.title}`).join('\n')
    : '  (none)';

  const generatedAt = losses.generatedAt ? fmtDate(losses.generatedAt) : 'unknown';

  const text = `
Weekly Report — Flooring Oddz and Endz
Data current as of: ${generatedAt}

STOCK TAKE LOSSES (last 7 days)
  Loss:  ${fmtMoney(losses.weeklyLoss)}
  Gain:  ${fmtMoney(losses.weeklyGain)}
  Net:   ${fmtMoney(losses.weeklyNetAmount)} ${losses.weeklyNetAmount < 0 ? '(net loss)' : '(net gain)'}

By category (net of gains):
${categoryLines || '  (no activity this week)'}

Worst SKUs this week:
${skuLines || '  (none)'}

TO-DO BOARD
  To Do: ${board.counts.todo || 0}   Doing: ${board.counts.doing || 0}   Blocked: ${board.counts.blocked || 0}   Done: ${board.counts.done || 0}

Blocked items:
${blockedLines}

Completed this week:
${completedLines}

---
Generated automatically from the team dashboard: ${DASHBOARD_URL}
`.trim();

  const categoryRowsHtml = (losses.weeklyCategoryTotals || [])
    .map((c) => {
      const isGain = c.amount < 0;
      const amount = (isGain ? '+' : '') + fmtMoney(Math.abs(c.amount));
      const color = isGain ? '#1e8e5a' : '#c0392b';
      return `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee;">${escapeHtml(c.category)}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right;color:${color};">${amount}</td></tr>`;
    })
    .join('');

  const skuRowsHtml = (losses.worstSkusThisWeek || [])
    .map(
      (s) =>
        `<tr><td style="padding:4px 8px;border-bottom:1px solid #eee;">${escapeHtml(s.productName)}</td><td style="padding:4px 8px;border-bottom:1px solid #eee;text-align:right;color:#c0392b;">${fmtMoney(s.amount)}</td></tr>`
    )
    .join('');

  const blockedHtml = board.blocked.length
    ? `<ul>${board.blocked.map((t) => `<li><strong>${escapeHtml(t.title)}</strong> — ${escapeHtml(t.blockedReason || 'no reason given')}</li>`).join('')}</ul>`
    : '<p style="color:#666;">None</p>';

  const completedHtml = board.completedThisWeek.length
    ? `<ul>${board.completedThisWeek.map((t) => `<li>${escapeHtml(t.title)}</li>`).join('')}</ul>`
    : '<p style="color:#666;">None</p>';

  const netColor = losses.weeklyNetAmount < 0 ? '#c0392b' : '#1e8e5a';

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#172b4d;max-width:640px;">
    <h2 style="margin-bottom:0;">Weekly Report — Flooring Oddz and Endz</h2>
    <p style="color:#666;margin-top:4px;">Data current as of ${generatedAt}</p>

    <h3>Stock take losses (last 7 days)</h3>
    <p>
      Loss: <strong>${fmtMoney(losses.weeklyLoss)}</strong> &nbsp;·&nbsp;
      Gain: <strong>${fmtMoney(losses.weeklyGain)}</strong> &nbsp;·&nbsp;
      Net: <strong style="color:${netColor};">${fmtMoney(losses.weeklyNetAmount)}</strong>
    </p>

    <h4>By category (net of gains)</h4>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">${categoryRowsHtml || '<tr><td style="color:#666;">No activity this week</td></tr>'}</table>

    <h4>Worst SKUs this week</h4>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">${skuRowsHtml || '<tr><td style="color:#666;">None</td></tr>'}</table>

    <h3>To-do board</h3>
    <p>To Do: ${board.counts.todo || 0} &nbsp;·&nbsp; Doing: ${board.counts.doing || 0} &nbsp;·&nbsp; Blocked: ${board.counts.blocked || 0} &nbsp;·&nbsp; Done: ${board.counts.done || 0}</p>

    <h4>Blocked items</h4>
    ${blockedHtml}

    <h4>Completed this week</h4>
    ${completedHtml}

    <p style="color:#999;font-size:12px;margin-top:24px;">
      Generated automatically from the team dashboard:
      <a href="${DASHBOARD_URL}">${DASHBOARD_URL}</a>
    </p>
  </div>
  `.trim();

  return { text, html };
}

async function main() {
  if (!DASHBOARD_URL) throw new Error('DASHBOARD_URL must be set in .env');

  console.log('[weekly-report] fetching dashboard data...');
  const data = await fetchDashboardData();

  const { text, html } = buildEmail(data);

  const dryRun = process.argv.includes('--dry-run') || !SMTP_HOST || !SMTP_USER || !SMTP_PASS;
  if (dryRun) {
    const fs = require('fs');
    fs.writeFileSync(path.join(__dirname, '..', 'weekly-report-preview.html'), html);
    console.log('[weekly-report] DRY RUN (SMTP not configured or --dry-run passed) — not sending.');
    console.log('[weekly-report] Preview written to weekly-report-preview.html\n');
    console.log(text);
    return;
  }

  if (!REPORT_TO) throw new Error('REPORT_TO (or SMTP_USER) must be set in .env');

  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    requireTLS: SMTP_PORT !== 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });

  const dateRange = new Date().toLocaleDateString('en-AU');
  console.log(`[weekly-report] sending to ${REPORT_TO}...`);
  await transporter.sendMail({
    from: REPORT_FROM,
    to: REPORT_TO,
    subject: `Weekly Stock Take Report — ${dateRange}`,
    text,
    html,
  });
  console.log('[weekly-report] sent successfully.');
}

main().catch((err) => {
  console.error('[weekly-report] failed:', err.response?.data || err.message);
  process.exit(1);
});
