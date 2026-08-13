#!/usr/bin/env python3
"""Precompute Los Banditos league analytics from raw Sleeper data -> assets/data.js
Re-run any time after refreshing data/raw (see fetch in README)."""
import json, os
from collections import defaultdict

RAW = os.environ.get("RAW_DIR") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "raw")
OUT = os.environ.get("DATA_OUT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets", "data.js")

def load(name):
    with open(os.path.join(RAW, name)) as f:
        return json.load(f)

chain = load("league_chain.json")
chain.sort(key=lambda l: l["season"])
SEASONS = [l["season"] for l in chain]
CURRENT = SEASONS[-1]
COMPLETE = [s for s, l in zip(SEASONS, chain) if l["status"] == "complete"]

pts_by_season = load("player_season_pts.json")

managers = {}          # user_id -> profile
seasons_out = {}       # season -> season summary
all_games = []         # every game (one row per team-game pair -> stored as matchup rows)

def pf(settings):
    return settings.get("fpts", 0) + settings.get("fpts_decimal", 0) / 100.0

def pa(settings):
    return settings.get("fpts_against", 0) + settings.get("fpts_against_decimal", 0) / 100.0

for lg in chain:
    season = lg["season"]
    users = load(f"users_{season}.json")
    rosters = load(f"rosters_{season}.json")
    matchups = load(f"matchups_{season}.json")
    pweek = lg["settings"]["playoff_week_start"]

    umap = {u["user_id"]: u for u in users}
    r2u = {r["roster_id"]: r["owner_id"] for r in rosters}

    for r in rosters:
        uid = r["owner_id"]
        u = umap.get(uid, {})
        m = managers.setdefault(uid, {
            "userId": uid, "name": u.get("display_name", "?"),
            "avatar": f"https://sleepercdn.com/avatars/thumbs/{u['avatar']}" if u.get("avatar") else None,
            "teamNames": {}, "seasons": [],
        })
        m["name"] = u.get("display_name", m["name"])
        if u.get("avatar"):
            m["avatar"] = f"https://sleepercdn.com/avatars/thumbs/{u['avatar']}"
        tn = (u.get("metadata") or {}).get("team_name") or u.get("display_name")
        m["teamNames"][season] = tn
        m["seasons"].append(season)

    # --- regular season games (weeks 1..pweek-1) ---
    season_games = []
    for wk in range(1, pweek):
        rows = matchups.get(str(wk)) or []
        by_mid = defaultdict(list)
        for row in rows:
            if row.get("matchup_id") is not None:
                by_mid[row["matchup_id"]].append(row)
        for mid, pair in by_mid.items():
            if len(pair) != 2:
                continue
            a, b = pair
            if (a.get("points") or 0) == 0 and (b.get("points") or 0) == 0:
                continue  # unplayed
            season_games.append({
                "season": season, "week": wk, "type": "regular",
                "a": {"uid": r2u[a["roster_id"]], "rid": a["roster_id"], "pts": round(a["points"], 2)},
                "b": {"uid": r2u[b["roster_id"]], "rid": b["roster_id"], "pts": round(b["points"], 2)},
            })

    # --- playoff games from brackets ---
    def bracket_games(bracket, kind):
        out = []
        for g in bracket or []:
            if g.get("w") is None:
                continue
            t1, t2 = g.get("t1"), g.get("t2")
            if t1 is None or t2 is None:
                continue
            # Sleeper doesn't always play a bracket game in week (pweek + r - 1) —
            # e.g. this league's 1-round consolation match lands in week 16, not 15.
            # Resolve the week empirically: the candidate week whose scores imply
            # the winner Sleeper recorded.
            candidates = [pweek + g["r"] - 1 + d for d in (0, 1, 2)]
            wk = candidates[0]
            for c in candidates:
                rows_c = matchups.get(str(c)) or []
                pm = {row["roster_id"]: row.get("points") or 0 for row in rows_c}
                if pm.get(t1) or pm.get(t2):
                    implied = t1 if pm.get(t1, 0) > pm.get(t2, 0) else t2
                    if implied == g["w"]:
                        wk = c
                        break
            rows = matchups.get(str(wk)) or []
            ptsmap = {row["roster_id"]: row.get("points") or 0 for row in rows}
            label = kind
            if g.get("p") == 1 and kind == "playoff":
                label = "championship"
            elif g.get("p") == 1 and kind == "losers":
                label = "sacko"
            elif g.get("p"):
                label = f"place-{g['p']}"
            out.append({
                "season": season, "week": wk, "type": label, "round": g["r"],
                "a": {"uid": r2u[t1], "rid": t1, "pts": round(ptsmap.get(t1, 0), 2)},
                "b": {"uid": r2u[t2], "rid": t2, "pts": round(ptsmap.get(t2, 0), 2)},
                "winner": r2u[g["w"]],
            })
        return out

    wb = load(f"winners_bracket_{season}.json") or []
    lb = load(f"losers_bracket_{season}.json") or []
    playoff_games = bracket_games(wb, "playoff") + bracket_games(lb, "losers")

    all_games.extend(season_games)
    all_games.extend(playoff_games)

    # --- placements ---
    placements = {}  # roster_id -> final place
    for g in wb:
        if g.get("p") and g.get("w") is not None:
            placements[g["w"]] = g["p"]
            placements[g["l"]] = g["p"] + 1
    for g in lb:
        if g.get("p") == 1 and g.get("w") is not None:
            placements[g["w"]] = 7
            placements[g["l"]] = 8

    champion = next((r2u[rid] for rid, p in placements.items() if p == 1), None)
    runner_up = next((r2u[rid] for rid, p in placements.items() if p == 2), None)
    sacko = next((r2u[rid] for rid, p in placements.items() if p == 8), None)

    standings = []
    for r in rosters:
        s = r["settings"]
        standings.append({
            "uid": r["owner_id"], "rid": r["roster_id"],
            "wins": s.get("wins", 0), "losses": s.get("losses", 0), "ties": s.get("ties", 0),
            "pf": round(pf(s), 2), "pa": round(pa(s), 2),
            "division": r["settings"].get("division"),
            "place": placements.get(r["roster_id"]),
        })
    standings.sort(key=lambda x: (-(x["wins"]), -x["pf"]))

    seasons_out[season] = {
        "season": season, "leagueId": lg["league_id"], "status": lg["status"],
        "playoffWeekStart": pweek, "champion": champion, "runnerUp": runner_up, "sacko": sacko,
        "divisions": {"1": (lg.get("metadata") or {}).get("division_1"),
                      "2": (lg.get("metadata") or {}).get("division_2")},
        "standings": standings,
        "regularGames": season_games,
        "playoffGames": playoff_games,
    }

# ============ career + records (complete seasons only for season-level records) ============
career = {}
for uid in managers:
    career[uid] = {"w": 0, "l": 0, "t": 0, "pf": 0.0, "pa": 0.0, "gp": 0,
                   "pw": 0, "pl": 0,  # playoff (winners-bracket incl. placement games)
                   "champs": [], "runnerUps": [], "sackos": [], "playoffApps": [],
                   "bestFinish": None, "seasonPlaces": {}}

for season in COMPLETE:
    so = seasons_out[season]
    playoff_uids = set()
    for g in so["playoffGames"]:
        if g["type"] in ("playoff", "championship") or g["type"].startswith("place-"):
            playoff_uids.add(g["a"]["uid"]); playoff_uids.add(g["b"]["uid"])
    for st in so["standings"]:
        c = career[st["uid"]]
        c["w"] += st["wins"]; c["l"] += st["losses"]; c["t"] += st["ties"]
        c["pf"] += st["pf"]; c["pa"] += st["pa"]
        c["gp"] += st["wins"] + st["losses"] + st["ties"]
        if st["place"]:
            c["seasonPlaces"][season] = st["place"]
            if c["bestFinish"] is None or st["place"] < c["bestFinish"]:
                c["bestFinish"] = st["place"]
    if so["champion"]: career[so["champion"]]["champs"].append(season)
    if so["runnerUp"]: career[so["runnerUp"]]["runnerUps"].append(season)
    if so["sacko"]: career[so["sacko"]]["sackos"].append(season)
    for uid in playoff_uids:
        career[uid]["playoffApps"].append(season)

for g in all_games:
    if g["type"] in ("playoff", "championship") or g["type"].startswith("place-"):
        win_uid = g.get("winner")
        for side, other in (("a", "b"), ("b", "a")):
            uid = g[side]["uid"]
            if uid == win_uid: career[uid]["pw"] += 1
            else: career[uid]["pl"] += 1

# head-to-head (all games incl. playoffs; split available by type)
h2h = defaultdict(lambda: defaultdict(lambda: {"w": 0, "l": 0, "t": 0, "pf": 0.0, "pa": 0.0,
                                               "pw": 0, "pl": 0}))
for g in all_games:
    a, b = g["a"], g["b"]
    is_playoff = g["type"] != "regular"
    if g["type"] == "regular":
        wa = a["pts"] > b["pts"]; tie = a["pts"] == b["pts"]
    else:
        wa = g.get("winner") == a["uid"]; tie = False
    for x, y, xwin in ((a, b, wa), (b, a, (not wa and not tie))):
        rec = h2h[x["uid"]][y["uid"]]
        rec["pf"] += x["pts"]; rec["pa"] += y["pts"]
        if is_playoff:
            rec["pw" if xwin else "pl"] += 1
        else:
            if tie: rec["t"] += 1
            elif xwin: rec["w"] += 1
            else: rec["l"] += 1

# single-game records over regular + bracket games
team_games = []
for g in all_games:
    a, b = g["a"], g["b"]
    if g["type"] == "regular":
        awin = a["pts"] > b["pts"]; tie = a["pts"] == b["pts"]
    else:
        awin = g.get("winner") == a["uid"]; tie = False
    for x, y, xwin in ((a, b, awin), (b, a, not awin and not tie)):
        team_games.append({"uid": x["uid"], "opp": y["uid"], "pts": x["pts"], "oppPts": y["pts"],
                           "season": g["season"], "week": g["week"], "type": g["type"],
                           "win": xwin, "tie": tie, "margin": round(x["pts"] - y["pts"], 2)})

def top(rows, key, n=10, rev=True):
    return sorted(rows, key=key, reverse=rev)[:n]

full_matchup_rows = []
seen = set()
for g in all_games:
    kid = (g["season"], g["week"], g["a"]["rid"], g["b"]["rid"])
    if kid in seen: continue
    seen.add(kid)
    hi, lo = (g["a"], g["b"]) if g["a"]["pts"] >= g["b"]["pts"] else (g["b"], g["a"])
    full_matchup_rows.append({"season": g["season"], "week": g["week"], "type": g["type"],
                              "hi": hi, "lo": lo, "margin": round(hi["pts"] - lo["pts"], 2),
                              "total": round(hi["pts"] + lo["pts"], 2)})

records = {
    "highScores": top(team_games, lambda r: r["pts"], 15),
    "lowScores": top(team_games, lambda r: r["pts"], 15, rev=False),
    "blowouts": top(full_matchup_rows, lambda r: r["margin"], 10),
    "nailbiters": top([r for r in full_matchup_rows if r["margin"] > 0], lambda r: r["margin"], 10, rev=False),
    "shootouts": top(full_matchup_rows, lambda r: r["total"], 10),
    "snoozers": top(full_matchup_rows, lambda r: r["total"], 10, rev=False),
    "bestLosses": top([r for r in team_games if not r["win"] and not r["tie"]], lambda r: r["pts"], 10),
    "worstWins": top([r for r in team_games if r["win"]], lambda r: r["pts"], 10, rev=False),
}

# streaks (regular season, chronological)
reg = sorted([t for t in team_games if t["type"] == "regular"],
             key=lambda t: (t["season"], t["week"]))
streaks = {}
cur = {}
for t in reg:
    uid = t["uid"]
    st = streaks.setdefault(uid, {"maxW": 0, "maxL": 0, "maxWspan": None, "maxLspan": None})
    c = cur.setdefault(uid, {"kind": None, "n": 0, "start": None})
    kind = "W" if t["win"] else ("T" if t["tie"] else "L")
    if kind == c["kind"]:
        c["n"] += 1
    else:
        c["kind"], c["n"], c["start"] = kind, 1, (t["season"], t["week"])
    span = [list(c["start"]), [t["season"], t["week"]]]
    if kind == "W" and c["n"] > st["maxW"]:
        st["maxW"], st["maxWspan"] = c["n"], span
    if kind == "L" and c["n"] > st["maxL"]:
        st["maxL"], st["maxLspan"] = c["n"], span
cur_streaks = {uid: {"kind": c["kind"], "n": c["n"]} for uid, c in cur.items()}

# luck: all-play record per season (regular)
luck = defaultdict(lambda: {"apW": 0, "apL": 0, "w": 0, "l": 0})
by_wk = defaultdict(list)
for t in reg:
    by_wk[(t["season"], t["week"])].append(t)
for (_, _), rows in by_wk.items():
    for t in rows:
        beat = sum(1 for o in rows if o["uid"] != t["uid"] and t["pts"] > o["pts"])
        lost = sum(1 for o in rows if o["uid"] != t["uid"] and t["pts"] < o["pts"])
        L = luck[t["uid"]]
        L["apW"] += beat; L["apL"] += lost
        L["w"] += 1 if t["win"] else 0; L["l"] += 0 if (t["win"] or t["tie"]) else 1

luck_out = {}
for uid, L in luck.items():
    gp = L["w"] + L["l"]
    ap_pct = L["apW"] / (L["apW"] + L["apL"]) if (L["apW"] + L["apL"]) else 0
    act_pct = L["w"] / gp if gp else 0
    luck_out[uid] = {"allPlayW": L["apW"], "allPlayL": L["apL"],
                     "allPlayPct": round(ap_pct, 4), "actualPct": round(act_pct, 4),
                     "luck": round(act_pct - ap_pct, 4)}

# season-level records (complete seasons)
season_rows = []
for season in COMPLETE:
    for st in seasons_out[season]["standings"]:
        gp = st["wins"] + st["losses"] + st["ties"]
        season_rows.append({"uid": st["uid"], "season": season, "wins": st["wins"],
                            "losses": st["losses"], "pf": st["pf"], "pa": st["pa"],
                            "ppg": round(st["pf"] / gp, 2) if gp else 0,
                            "place": st["place"]})
records["bestSeasonsPF"] = top(season_rows, lambda r: r["pf"], 8)
records["worstSeasonsPF"] = top(season_rows, lambda r: r["pf"], 8, rev=False)
records["bestRecords"] = top(season_rows, lambda r: (r["wins"], r["pf"]), 8)
records["worstRecords"] = top(season_rows, lambda r: (-r["losses"], -r["pa"]), 8)

# ============ drafts ============
drafts_out = {}
for season in SEASONS:
    dlist = load(f"draft_picks_{season}.json")
    boards = []
    for d in dlist:
        picks = []
        for p in sorted(d["picks"], key=lambda x: x["pick_no"]):
            md = p.get("metadata") or {}
            pid = p["player_id"]
            pts_season = (pts_by_season.get(season) or {}).get(pid, {}).get("pts", None)
            pts_total = round(sum((pts_by_season.get(s) or {}).get(pid, {}).get("pts", 0)
                                  for s in COMPLETE if s >= season), 1)
            picks.append({
                "no": p["pick_no"], "round": p["round"],
                "uid": next((u for r, u in [(rr["roster_id"], rr["owner_id"]) for rr in load(f"rosters_{season}.json")] if r == p.get("roster_id")), p.get("picked_by")),
                "player": f'{md.get("first_name","")} {md.get("last_name","")}'.strip(),
                "pos": md.get("position"), "team": md.get("team"),
                "ptsSeason": pts_season, "ptsSince": pts_total,
            })
        boards.append({"draftId": d["draft"]["draft_id"], "rounds": d["draft"]["settings"].get("rounds"),
                       "type": d["draft"]["type"], "picks": picks})
    drafts_out[season] = boards

payload = {
    "generatedAt": "2026-08-11",
    "leagueId": chain[-1]["league_id"],
    "leagueName": chain[-1]["name"],
    "seasons": SEASONS, "completeSeasons": COMPLETE, "currentSeason": CURRENT,
    "currentLeague": {"leagueId": chain[-1]["league_id"],
                      "playoffWeekStart": chain[-1]["settings"]["playoff_week_start"],
                      "playoffTeams": chain[-1]["settings"].get("playoff_teams", 6),
                      "totalRosters": chain[-1].get("total_rosters", 8),
                      "divisions": {"1": (chain[-1].get("metadata") or {}).get("division_1"),
                                    "2": (chain[-1].get("metadata") or {}).get("division_2")}},
    "managers": managers,
    "career": career,
    "seasonsData": seasons_out,
    "h2h": {a: dict(bs) for a, bs in h2h.items()},
    "records": records,
    "streaks": streaks,
    "currentStreaks": cur_streaks,
    "luck": luck_out,
    "drafts": drafts_out,
}

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as f:
    f.write("window.LEAGUE_DATA = ")
    json.dump(payload, f)
    f.write(";\n")
print("Wrote", OUT, os.path.getsize(OUT) // 1024, "KB")
