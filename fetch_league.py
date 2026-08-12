#!/usr/bin/env python3
"""Walk the Sleeper league chain and download all historical data."""
import json, os, sys, urllib.request

BASE = "https://api.sleeper.app/v1"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "raw")
START_LEAGUE = "1315162051303194624"

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

print("Done. Seasons:", [lg["season"] for lg in chain])
