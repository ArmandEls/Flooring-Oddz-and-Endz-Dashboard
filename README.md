# Team Dashboard

A small, self-hosted dashboard with two things on it:

1. **Recent stock take losses** — pulled live from Cin7 Core, broken down by
   product category, looking back at most 6 months.
2. **A kanban to-do board** — To Do / Doing / Done columns. Anyone with the
   link can add items, move them between columns (buttons or drag & drop),
   and delete them. No account or login of any kind — it's just a web page.

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
- `STOCK_LOSS_DAYS` — how far back to look (capped at 180 days / 6 months
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

- Each completed stock adjustment has a `Transactions` entry moving value
  into or out of "Stock on Hand". A negative amount means inventory was
  written down (a loss); positive means stock was added. We sum the negative
  side per adjustment.
- To get a category for each loss, we look up the products involved
  (`Category` lives on the Product record, not the adjustment) and split the
  adjustment's loss evenly across the distinct categories it touched.
- Results are cached for 15 minutes; use the Refresh button for an
  on-demand update. Only the most recent adjustments are scanned per refresh
  (capped) to keep it fast and avoid hammering the Cin7 API — if you have a
  very high volume of stock adjustments, the panel will note that results
  are truncated to the most recent ones.

## Project layout

```
server/
  index.js   Express app + API routes
  store.js   JSON-file task storage
  cin7.js    Cin7 Core API client + loss aggregation
public/      Static frontend (no build step)
data/        tasks.json lives here (gitignored)
```
