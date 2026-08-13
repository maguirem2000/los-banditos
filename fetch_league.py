#!/usr/bin/env python3
"""Walk the Sleeper league chain and download all historical data."""
import json, os, sys, urllib.request

BASE = "https://api.sleeper.app/v1"
OUT = os.environ.get("RAW_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "raw")
START_LEAGUE = os.environ.get("LEAGUE_ID", "1315162051303194624")
os.makedirs(OUT, exist_ok=True)

def get(path):
    url = f"{BASE}{path}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            return json.load(r)
    except Exception as e:
        print(f"  ! {path}: {e}")
        return None

def save(name, obj):
    with open(os.path.join(OUT, name), "w") as f:
        json.dump(obj, f)

# 1. Walk the chain
chain = []
lid = START_LEAGUE
while lid and lid != "0":
    lg = get(f"/league/{lid}")
    if not lg:
        break
    chain.append(lg)
    print(f"Season {lg['season']}: {lg['name']} (league {lid}, status={lg['status']})")
    lid = lg.get("previous_league_id")

save("league_chain.json", chain)

# 2. Per-season data
for lg in chain:
    lid = lg["league_id"]
    season = lg["season"]
    print(f"Fetching season {season}...")
    users = get(f"/league/{lid}/users")
    rosters = get(f"/league/{lid}/rosters")
    save(f"users_{season}.json", users)
    save(f"rosters_{season}.json", rosters)

    # matchups: weeks 1..(playoff_week_start + rounds). Fetch 1-18 to be safe.
    matchups = {}
    for wk in range(1, 19):
        m = get(f"/league/{lid}/matchups/{wk}")
        if m:
            matchups[str(wk)] = m
    save(f"matchups_{season}.json", matchups)

    wb = get(f"/league/{lid}/winners_bracket")
    lb = get(f"/league/{lid}/losers_bracket")
    save(f"winners_bracket_{season}.json", wb)
    save(f"losers_bracket_{season}.json", lb)

    drafts = get(f"/league/{lid}/drafts")
    save(f"drafts_{season}.json", drafts)
    all_picks = []
    for d in (drafts or []):
        picks = get(f"/draft/{d['draft_id']}/picks")
        if picks:
            all_picks.append({"draft": d, "picks": picks})
    save(f"draft_picks_{season}.json", all_picks)

# 3. transactions + traded picks (for trade/FAAB analytics)
for lg in chain:
    lid, season = lg["league_id"], lg["season"]
    txns = []
    for wk in range(1, 19):
        t = get(f"/league/{lid}/transactions/{wk}")
        if t:
            txns.extend(t)
    save(f"transactions_{season}.json", txns)
    save(f"traded_picks_{season}.json", get(f"/league/{lid}/traded_picks"))

# 4. player database (names/positions) — big file, gitignored, needed by build_extras.py
players = get("/players/nfl")
save("players_nfl.json", players)

# 5. per-season PPR totals for drafted players (draft steal/bust analysis)
pids = set()
for lg in chain:
    for d in json.load(open(os.path.join(OUT, f"draft_picks_{lg['season']}.json"))):
        for p in d["picks"]:
            pids.add(p["player_id"])
slim = {}
for lg in chain:
    season = lg["season"]
    stats = get(f"/stats/nfl/regular/{season}") or {}
    slim[season] = {pid: {"pts": round((stats.get(pid) or {}).get("pts_ppr") or 0, 1),
                          "gp": (stats.get(pid) or {}).get("gp") or 0}
                    for pid in pids if pid in stats}
save("player_season_pts.json", slim)

print("Done. Seasons:", [lg["season"] for lg in chain])
