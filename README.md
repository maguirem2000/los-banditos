# Los Banditos — League Hub

A full stats website for the Los Banditos dynasty fantasy football league (Sleeper league `1315162051303194624`).

## What's inside

- **Home** — reigning champ, all-time records tiles, live current-week scoreboard, all-time standings
- **Standings** — by division, any season, with live data for the current season
- **Schedule** — every week of every season, including playoff brackets
- **Head-to-Head** — all-time manager-vs-manager matrix; click any cell for the full game log
- **Record Book** — highest/lowest scores ever, blowouts, nailbiters, best losses, worst wins, streaks, best/worst seasons
- **Power Rankings** — weekly computed power scores with trend chart (35% scoring, 30% all-play, 20% record, 15% form)
- **Franchises** — per-manager franchise pages: all-time legends, positional report cards, longest tenures, "Day One" players
- **Awards** — league superlatives (The Gambler, Glass Cannon, The Vulture...) plus the weekly awards archive
- **Boneheads** — career lineup efficiency vs the optimal lineup, worst start/sit weeks, games thrown away by bad benching
- **Trades** — full trade log with "who won the trade" verdicts (points since the deal), FAAB ledger, biggest bids, best pickups ever
- **Trophy Room** — championship banners with full title lineups (plaques), career hardware, season finishes, and drawn playoff brackets
- **Shame Wall** — Shitter tracker, worst weeks, worst blowout losses, longest skids
- **Drafts** — every draft board (2023 startup + rookie drafts), steals/busts, traded-pick "via" tags, and the future pick ledger
- **Trade Finder** (Moves tab) — live trade-compatibility matrix: every roster priced with FantasyCalc dynasty market values (1QB/8-team/PPR), positional surplus vs. need per team, win-now vs. rebuilding timelines, 30-day value trends, top trade bait, auto-suggested value-balanced swaps for the best-fitting pairs, and a market-inefficiency board (win-now vs. dynasty price: buy-low vets and sellable future premiums, flagged against each owner's timeline)

- **Pick'em & Poll** (Season tab) — weekly winner picks and a rank-the-league power poll, submitted right on the site with per-manager PINs. Locks at Thursday kickoff; crowd percentages and a season leaderboard after lock. Backend: Cloudflare Worker + KV in `worker/` (deploy with `npx wrangler deploy`; PINs live in the `PINS` secret).

Plus, live on the current season: **playoff odds** (Monte Carlo simulation on the Power Rankings tab), **matchup projections** on the schedule, **grudge-match previews** (all-time series + streaks on every upcoming matchup), an auto-generated **weekly recap**, **revenge-game flags**, a **records watch**, a **schedule what-if grid**, and a preseason **kickoff countdown**. The site is an installable PWA — "Add to Home Screen" on your phone.

## How data works

- **History (2023–2025)** is precomputed into `assets/data.js` by `build_data.py`.
- **The current season** is fetched live from the Sleeper API every time the page loads —
  standings, matchups, and scores stay current automatically with zero maintenance.

## Running it

It's a fully static site — open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8080
```

Host it anywhere static files go (GitHub Pages, Netlify, Cloudflare Pages) and share the URL with the league.

## Auto-refresh

A GitHub Action (`.github/workflows/refresh.yml`) re-pulls Sleeper data and rebuilds
the analytics **every Tuesday morning** and pushes the result — the site maintains
itself. It can also be run on demand from the repo's Actions tab.

## Refreshing history manually

After a season completes, re-pull the raw data and rebuild:

```bash
python3 fetch_league.py   # re-download all seasons from Sleeper
python3 build_data.py     # recompute assets/data.js
python3 build_extras.py   # recompute assets/extras.js (lineups, trades, player records)
```

Also worth re-running mid-season occasionally so player names for new pickups
resolve in recaps (the name map is baked at build time).

(`fetch_league.py` is the downloader used to build this — it walks the league's
`previous_league_id` chain so new seasons are picked up automatically.)
