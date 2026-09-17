# Flooring Oddz and Endz Dashboard

A small, self-hosted dashboard with two things on it:

1. **Recent stock take losses** — pulled live from Cin7 Core, broken down by
   product category (net of any gains booked against that category in the
   same window), plus a highlight of the worst SKUs over the last 7 days.
   Looks back at most 2 months.
2. **A kanban to-do board** — To Do / Doing / Done columns. Anyone with the
   link can add items, move them between columns (buttons or drag & drop),
   and delete them. No account or login of any kind — it's just a web page.
   Items can optionally repeat daily, weekly, or monthly — a repeating item
   marked Done automatically moves back to To Do once the next period
   starts (next day/week/month), no need to re-add it.

It's a plain Node.js + Express app with no database server: tasks are stored
in `data/tasks.json` on disk. That keeps it easy to run anywhere Node runs.

## Setup

```bash
npm install
cp .env.example .env
```

Edit `.env`:

- `PORT` — defaults to 3000.
- `CIN7_ACCOUNT_ID` / `CIN7_APPLICATION_KEY` — from Cin7 Core under
  **Integrations & Add-ons > API**. Leave blank and the losses panel just
  shows a "not connected" message; the to-do board works either way.
- `STOCK_LOSS_DAYS` — how far back to look (capped at 60 days / 2 months
  regardless of what you set here).

## Run it

```bash
npm start
```

Then open `http://localhost:3000` (or whatever `PORT` you set).

## Making it reachable by the team

This app has no login system by design, so "who can open the link" is
entirely about where you run it:

- **On your office network**: run `npm start` on a machine that's always on
  (a spare PC, a NAS that runs Node, etc.), then share
  `http://<that machine's LAN IP>:3000` with the team. Nothing leaves your
  network.
- **On the public internet**: deploy it to any host that runs Node (a small
  VPS, Render, Railway, Fly.io, etc.) and share the URL. Because there's no
  login, **anyone with the link can edit the board** — fine for an internal
  tool on an unlisted URL, but don't put anything sensitive in card titles,
  and consider putting it behind your host's basic-auth or a VPN if it needs
  to be public-facing.
- If you deploy somewhere with an ephemeral filesystem (e.g. a free-tier
  platform that wipes disk on redeploy), `data/tasks.json` won't survive a
  redeploy. Use a host with a persistent volume/disk if you want the board's
  history to stick around.

## How the stock take losses number is calculated

Cin7 Core doesn't have a single "loss" field — it's derived:

- Every completed stock adjustment in the window is scanned (not just a
  sample) — each one has a `Transactions` entry moving value into or out of
  "Stock on Hand". A negative amount means inventory was written down (a
  loss); positive means stock was added/corrected up (a gain).
- The headline total is the sum of the loss side only, across the window.
  `totalGain`/`netAmount` (gain side, and loss-minus-gain) are also computed
  and available via the API, but aren't shown as a state-level split — see
  below for why.
- Each stock take's line items carry a Cin7 `Location` (e.g. "Main
  Warehouse", "Melbourne", "Adelaide Warehouse", "Perth Holding Warehouse") —
  this account's locations are mapped to the three states in
  `stateForLocationName()` in `server/cin7.js`: "Main Warehouse" and "Perth
  Holding Warehouse" → Perth, "Melbourne" and "Back Orders Melbourne" →
  Melbourne, "Adelaide Warehouse" → Adelaide, anything else → Other. Unlike
  product category, this needs no extra API call — Location is already on
  each line item. The breakdown is built from the same gross loss figure as
  the "Loss" column in the table below it, on purpose: summing "By state"
  equals summing that table.
- Cin7 only gives a total $ loss per stock take, not a per-line dollar
  value, so splitting that total across states/products is necessarily an
  approximation. It's weighted by **line count**, not split evenly: a
  state's share of a stock take's loss is `loss × (that state's line count /
  total line count)`, and within a state, its share is split evenly across
  its own lines. This matters — an earlier version split evenly *per state
  touched*, which meant a 45-line stock take with 44 Perth lines and 1
  Melbourne line gave Melbourne 50% of the loss (since 2 states were
  touched), dumping the whole amount onto that one Melbourne product
  regardless of whether it actually moved. Line-count weighting means that
  state now correctly gets ~2% instead. Still treat per-product amounts
  (here and in "Worst SKUs") as "which products/states keep showing up in
  loss-making counts, roughly how much," not exact per-SKU accounting.
- "Worst SKUs this week" splits each loss (last 7 days only) evenly across
  the specific SKUs that stock take counted, using the SKU/product name
  already present on the stock take's line items (no extra API calls).
- Results are cached for 15 minutes; use the Refresh button for an
  on-demand update. There's a generous safety ceiling (600 stock takes) on
  how many get scanned per refresh — the panel will note if results are
  truncated, which would only happen at unusually high volume.

## Cin7 blocked on the deployed host

Cin7 Core rejects API calls from Render's network (403 "Incorrect
credentials!") even though the same credentials work everywhere else — this
looks like Cin7 blocking generic cloud-hosting IP ranges rather than
anything wrong with your account. Workaround: a relay script
(`scripts/push-losses.js`) runs on a machine Cin7 *does* allow (e.g. this
one), fetches the losses, and pushes them to the deployed dashboard via a
token-authenticated endpoint.

- `npm run relay` runs it once. Needs `DASHBOARD_URL` and `RELAY_TOKEN` set
  in `.env` (the deployed instance needs the same `RELAY_TOKEN`, and should
  *not* have `CIN7_ACCOUNT_ID`/`CIN7_APPLICATION_KEY` set, otherwise it'll
  try — and fail — to call Cin7 directly instead of waiting for the relay).
- For it to run automatically, set up a recurring task on the relay
  machine (Windows Task Scheduler, cron, etc.) calling
  `node scripts/push-losses.js` every 30 minutes or so. A full scan takes
  several minutes, so don't schedule it much tighter than that.
- If the relay machine is off, the dashboard just keeps showing the last
  data it received (with its timestamp) rather than breaking.

## Weekly email report

`scripts/send-weekly-report.js` compiles this week's numbers (loss/gain/net,
category breakdown, worst SKUs) plus a to-do board snapshot (counts, what's
blocked and why, what got done) and emails it. It reads from the live
dashboard's own API (`DASHBOARD_URL`), not from Cin7 directly, so it just
uses whatever the relay most recently pushed.

Setup in `.env` on whichever machine will send it:

- `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` — credentials for the
  mailbox it sends *from*. For Microsoft 365: host `smtp.office365.com`, port
  `587`, and an app password for that account (Authenticated SMTP must be
  enabled for the mailbox — ask your M365 admin if it isn't).
- `REPORT_TO` — who receives it (defaults to `SMTP_USER`, i.e. sends to
  itself so you can review before forwarding).
- `REPORT_FROM` — optional, defaults to `SMTP_USER`.

Run `npm run weekly-report` once to test. If SMTP isn't configured yet (or
you pass `--dry-run`), it writes `weekly-report-preview.html` instead of
sending, so you can check the content first. Schedule it weekly (e.g.
Monday 7am) the same way as the relay task — see below.

## Windows Task Scheduler notes (relay + weekly report)

Both recurring scripts are launched via a small `.vbs` wrapper
(`scripts/run-relay-hidden.vbs`, and similarly for the weekly report)
instead of pointing the scheduled task straight at `node.exe`. Two reasons:

1. **No visible window.** A scheduled task set to "run only when logged on"
   normally pops a console window on the desktop each time it fires — using
   `wscript.exe //B path\to\wrapper.vbs` with `WScript.Shell.Run(cmd, 0,
   False)` launches it fully hidden.
2. **Immune to unrelated Ctrl+C.** If the task's process shares a console
   with something else running interactively in the same session, a Ctrl+C
   sent elsewhere can kill it mid-run. The `.vbs` launcher detaches it into
   its own process, sidestepping that.

## Project layout

```
server/
  index.js   Express app + API routes
  store.js   JSON-file task storage
  cin7.js    Cin7 Core API client + loss aggregation
public/      Static frontend (no build step)
data/        tasks.json lives here (gitignored)
```
