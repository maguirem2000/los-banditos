#!/usr/bin/env python3
"""Compute advanced analytics (lineups, trades, waivers, player records) -> assets/extras.js
Run after build_data.py (reads its output for season/game structure)."""
import json, os
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "data", "raw")

def load(name):
    with open(os.path.join(RAW, name)) as f:
        return json.load(f)

DATA = json.loads(open(os.path.join(HERE, "assets", "data.js")).read()
                  .replace("window.LEAGUE_DATA = ", "").rstrip(";\n"))
SEASONS = DATA["seasons"]
COMPLETE = DATA["completeSeasons"]
CURRENT = DATA["currentSeason"]

chain = {lg["season"]: lg for lg in load("league_chain.json")}
players_db = load("players_nfl.json")

matchups = {s: load(f"matchups_{s}.json") for s in SEASONS}
rosters = {s: load(f"rosters_{s}.json") for s in SEASONS}
r2u = {s: {r["roster_id"]: r["owner_id"] for r in rosters[s]} for s in SEASONS}
u2r = {s: {u: r for r, u in r2u[s].items()} for s in SEASONS}

def pos_of(pid):
    p = players_db.get(pid) or {}
    return p.get("position") or (p.get("fantasy_positions") or ["?"])[0]

def name_of(pid):
    p = players_db.get(pid) or {}
    n = f'{p.get("first_name","")} {p.get("last_name","")}'.strip()
    return n or (pid if not pid.isdigit() else f"Player {pid}")

# ---------------- which team-weeks count (regular + bracket only) ----------------
# regular weeks: 1..pweek-1 where the roster posted points; bracket weeks: from data.js playoffGames
counted = defaultdict(set)   # (season) -> set of (week, roster_id)
week_rows = {}               # (season, week) -> {roster_id: row}
for s in SEASONS:
    pweek = chain[s]["settings"]["playoff_week_start"]
    for wk_str, rows in matchups[s].items():
        wk = int(wk_str)
        week_rows[(s, wk)] = {r["roster_id"]: r for r in rows}
    sd = DATA["seasonsData"][s]
    for g in sd["regularGames"]:
        counted[s].add((g["week"], g["a"]["rid"]))
        counted[s].add((g["week"], g["b"]["rid"]))
    for g in sd["playoffGames"]:
        counted[s].add((g["week"], g["a"]["rid"]))
        counted[s].add((g["week"], g["b"]["rid"]))

# ---------------- optimal lineup ----------------
SLOTS = [p for p in chain[CURRENT]["roster_positions"] if p != "BN"]

def optimal_points(row):
    pool = defaultdict(list)
    for pid in row.get("players") or []:
        pts = (row.get("players_points") or {}).get(pid) or 0
        pool[pos_of(pid)].append(pts)
    for k in pool:
        pool[k].sort(reverse=True)
    total, flex_pool = 0.0, []
    fixed = {"QB": SLOTS.count("QB"), "RB": SLOTS.count("RB"), "WR": SLOTS.count("WR"),
             "TE": SLOTS.count("TE"), "K": SLOTS.count("K"), "DEF": SLOTS.count("DEF")}
    for pos, n in fixed.items():
        picks = pool.get(pos, [])[:n]
        total += sum(picks)
        flex_pool.extend(pool.get(pos, [])[n:] if pos in ("RB", "WR", "TE") else [])
    flex_pool.sort(reverse=True)
    total += sum(flex_pool[:SLOTS.count("FLEX")])
    return round(total, 2)

lineup_career = defaultdict(lambda: {"act": 0.0, "opt": 0.0, "weeks": 0})
worst_benchings, lost_by_bench = [], []
top_starters, top_benched = [], []
weekly_awards = defaultdict(dict)

for s in SEASONS:
    for (wk, rid) in sorted(counted[s]):
        row = week_rows.get((s, wk), {}).get(rid)
        if not row:
            continue
        uid = r2u[s][rid]
        act = row.get("points") or 0
        opt = optimal_points(row)
        c = lineup_career[uid]
        c["act"] += act; c["opt"] += max(opt, act); c["weeks"] += 1
        missed = round(max(opt, act) - act, 2)
        # opponent actual (from same matchup_id)
        opp_row = next((r for r in week_rows[(s, wk)].values()
                        if r.get("matchup_id") == row.get("matchup_id") and r["roster_id"] != rid), None)
        entry = {"uid": uid, "season": s, "week": wk, "act": act, "opt": max(opt, act), "missed": missed}
        if opp_row:
            opp_pts = opp_row.get("points") or 0
            entry["opp"] = r2u[s][opp_row["roster_id"]]
            entry["oppPts"] = opp_pts
            if act < opp_pts and max(opt, act) > opp_pts:
                lost_by_bench.append(entry)
        if missed > 0:
            worst_benchings.append(entry)
        starters = set(row.get("starters") or [])
        for pid in row.get("players") or []:
            pts = (row.get("players_points") or {}).get(pid) or 0
            rec = {"pid": pid, "pts": round(pts, 2), "uid": uid, "season": s, "week": wk}
            (top_starters if pid in starters else top_benched).append(rec)
        # weekly awards (regular-season weeks only need one entry per week; do all counted)
        wa = weekly_awards[s].setdefault(str(wk), {"topPts": -1, "benchPts": -1})
        for pid in starters:
            pts = (row.get("players_points") or {}).get(pid) or 0
            if pts > wa["topPts"]:
                wa.update({"topPts": round(pts, 2), "topPid": pid, "topUid": uid})
        for pid in (set(row.get("players") or []) - starters):
            pts = (row.get("players_points") or {}).get(pid) or 0
            if pts > wa["benchPts"]:
                wa.update({"benchPts": round(pts, 2), "benchPid": pid, "benchUid": uid})

top_starters.sort(key=lambda x: -x["pts"])
top_benched.sort(key=lambda x: -x["pts"])
worst_benchings.sort(key=lambda x: -x["missed"])
lost_by_bench.sort(key=lambda x: -(x["opt"] - x["oppPts"]))
top_starters = top_starters[:20]
top_benched = top_benched[:12]
worst_benchings = worst_benchings[:12]

lineup_out = {}
for uid, c in lineup_career.items():
    lineup_out[uid] = {"act": round(c["act"], 1), "opt": round(c["opt"], 1),
                       "eff": round(c["act"] / c["opt"], 4) if c["opt"] else 1,
                       "weeks": c["weeks"],
                       "lostByBench": sum(1 for e in lost_by_bench if e["uid"] == uid)}

# ---------------- franchise legends / tenure / positional ----------------
started_pts = defaultdict(float)      # (uid, pid) -> started points
started_wks = defaultdict(int)
rostered_wks = defaultdict(int)       # (uid, pid) -> weeks on roster
season_started = defaultdict(float)   # (uid, pid, season) -> started points
pos_pts = defaultdict(lambda: defaultdict(float))  # uid -> pos -> started points

for s in SEASONS:
    for (wk, rid) in counted[s]:
        row = week_rows.get((s, wk), {}).get(rid)
        if not row:
            continue
        uid = r2u[s][rid]
        starters = set(row.get("starters") or [])
        for pid in row.get("players") or []:
            rostered_wks[(uid, pid)] += 1
            if pid in starters:
                pts = (row.get("players_points") or {}).get(pid) or 0
                started_pts[(uid, pid)] += pts
                started_wks[(uid, pid)] += 1
                season_started[(uid, pid, s)] += pts
                pos_pts[uid][pos_of(pid)] += pts

current_roster = {}   # uid -> set of pids on the 2026 roster
for r in rosters[CURRENT]:
    current_roster[r["owner_id"]] = set(r.get("players") or [])
startup_drafted = {}  # pid -> uid who drafted them in the 2023 startup
for d in load("draft_picks_2023.json"):
    for p in d["picks"]:
        uid = r2u["2023"].get(p.get("roster_id"))
        if uid:
            startup_drafted[p["player_id"]] = uid

franchise = {}
for uid in {u for (u, _p) in rostered_wks}:
    legends = sorted(((pid, v) for (u, pid), v in started_pts.items() if u == uid),
                     key=lambda x: -x[1])[:8]
    best_seasons = sorted((((pid, se), v) for (u, pid, se), v in season_started.items() if u == uid),
                          key=lambda x: -x[1])[:5]
    tenure = sorted(((pid, v) for (u, pid), v in rostered_wks.items() if u == uid),
                    key=lambda x: -x[1])[:8]
    franchise[uid] = {
        "legends": [{"pid": pid, "pts": round(v, 1), "weeks": started_wks[(uid, pid)],
                     "active": pid in current_roster.get(uid, set())} for pid, v in legends],
        "bestSeasons": [{"pid": pid, "season": se, "pts": round(v, 1)} for (pid, se), v in best_seasons],
        "tenure": [{"pid": pid, "weeks": v, "active": pid in current_roster.get(uid, set()),
                    "dayOne": startup_drafted.get(pid) == uid and pid in current_roster.get(uid, set())}
                   for pid, v in tenure],
        "pos": {p: round(v, 1) for p, v in pos_pts[uid].items()},
    }
# league-wide tenure leaders
tenure_leaders = sorted(rostered_wks.items(), key=lambda kv: -kv[1])[:12]
tenure_out = [{"uid": u, "pid": pid, "weeks": v, "active": pid in current_roster.get(u, set()),
               "dayOne": startup_drafted.get(pid) == u and pid in current_roster.get(u, set())}
              for (u, pid), v in tenure_leaders]

# ---------------- what-if schedule grid (per complete season) ----------------
what_if = {}
for s in COMPLETE:
    score = defaultdict(dict)  # week -> uid -> pts
    sched = defaultdict(dict)  # uid -> week -> opponent uid
    for g in DATA["seasonsData"][s]["regularGames"]:
        score[g["week"]][g["a"]["uid"]] = g["a"]["pts"]
        score[g["week"]][g["b"]["uid"]] = g["b"]["pts"]
        sched[g["a"]["uid"]][g["week"]] = g["b"]["uid"]
        sched[g["b"]["uid"]][g["week"]] = g["a"]["uid"]
    uids = sorted(sched.keys(), key=lambda u: u2r[s].get(u, 9))
    grid = {}
    for a in uids:
        grid[a] = {}
        for b in uids:
            w = l = 0
            for wk, opp in sched[b].items():
                if wk not in score or a not in score[wk]:
                    continue
                opp_score = score[wk][b] if opp == a else score[wk].get(opp)
                if opp_score is None:
                    continue
                if score[wk][a] > opp_score: w += 1
                elif score[wk][a] < opp_score: l += 1
            grid[a][b] = [w, l]
    what_if[s] = {"uids": uids, "grid": grid}

# ---------------- roster membership by week (for pts-since calculations) ----------------
# member[(uid)][(season, week)] = set(pids)  — built lazily from week_rows
SEASON_ORDER = {s: i for i, s in enumerate(SEASONS)}
ALL_WEEKS = []  # global chronological list of (season, week)
for s in SEASONS:
    wks = sorted({wk for (wk, _r) in counted[s]} | {int(w) for w in matchups[s] if matchups[s][w]})
    ALL_WEEKS.extend((s, w) for w in wks)

def pts_since(pid, uid, season, week):
    """Points pid scored in uid's lineup-weeks strictly after (season, week). Counts all rostered weeks."""
    total, games = 0.0, 0
    started = False
    for (s, w) in ALL_WEEKS:
        if not started:
            if s == season and w > week or SEASON_ORDER[s] > SEASON_ORDER[season]:
                started = True
            else:
                continue
        rid = u2r.get(s, {}).get(uid)
        if rid is None:
            continue
        row = week_rows.get((s, w), {}).get(rid)
        if not row or pid not in (row.get("players") or []):
            continue
        pts = (row.get("players_points") or {}).get(pid) or 0
        total += pts
        games += 1
    return round(total, 1), games

# ---------------- trades ----------------
trades_out = []
for s in SEASONS:
    for t in load(f"transactions_{s}.json"):
        if t["type"] != "trade" or t["status"] != "complete":
            continue
        wk = t.get("leg") or 1
        sides = defaultdict(lambda: {"players": [], "picks": [], "faab": 0})
        for pid, rid in (t.get("adds") or {}).items():
            uid = r2u[s][rid]
            pts, games = pts_since(pid, uid, s, wk)
            sides[uid]["players"].append({"pid": pid, "name": name_of(pid), "pos": pos_of(pid),
                                          "pts": pts, "games": games})
        for dp in t.get("draft_picks") or []:
            uid = r2u[s][dp["owner_id"]]
            orig = r2u[s].get(dp["roster_id"], dp["roster_id"])
            sides[uid]["picks"].append({"season": dp["season"], "round": dp["round"], "origUid": orig})
        for wb in t.get("waiver_budget") or []:
            sides[r2u[s][wb["receiver"]]]["faab"] += wb["amount"]
            sides[r2u[s][wb["sender"]]]["faab"] -= 0  # shown on receiver side only
        side_list = []
        for uid, got in sides.items():
            got["uid"] = uid
            got["pts"] = round(sum(p["pts"] for p in got["players"]), 1)
            side_list.append(got)
        side_list.sort(key=lambda x: -x["pts"])
        verdict = None
        if any(x["players"] for x in side_list) and len(side_list) >= 2:
            margin = side_list[0]["pts"] - side_list[1]["pts"]
            has_unplayed = s == CURRENT and all(x["pts"] == 0 for x in side_list)
            if not has_unplayed and margin >= 15:
                verdict = {"winner": side_list[0]["uid"], "margin": round(margin, 1)}
        trades_out.append({"season": s, "week": wk, "ts": t.get("status_updated"),
                           "sides": side_list, "verdict": verdict})
trades_out.sort(key=lambda x: -(x["ts"] or 0))

# ---------------- waivers / FAAB / pickups ----------------
faab_season = defaultdict(dict)
top_bids, pickups = [], []
for s in SEASONS:
    for t in load(f"transactions_{s}.json"):
        if t["status"] != "complete" or t["type"] not in ("waiver", "free_agent"):
            continue
        wk = t.get("leg") or 1
        bid = ((t.get("settings") or {}).get("waiver_bid") or 0) if t["type"] == "waiver" else 0
        for pid, rid in (t.get("adds") or {}).items():
            uid = r2u[s][rid]
            if bid:
                faab_season[s][uid] = faab_season[s].get(uid, 0) + bid
                top_bids.append({"uid": uid, "season": s, "week": wk, "pid": pid, "bid": bid})
            pts, games = pts_since(pid, uid, s, wk - 1)  # include the week of the claim
            if pts > 0:
                pickups.append({"uid": uid, "season": s, "week": wk, "pid": pid,
                                "name": name_of(pid), "pos": pos_of(pid),
                                "bid": bid, "pts": pts, "games": games, "kind": t["type"]})
top_bids.sort(key=lambda x: -x["bid"])
pickups.sort(key=lambda x: -x["pts"])

# ---------------- division splits ----------------
div_out = {}
for s in COMPLETE:
    divmap = {r2u[s][r["roster_id"]]: (r["settings"].get("division")) for r in rosters[s]}
    recs = defaultdict(lambda: {"divW": 0, "divL": 0})
    for g in DATA["seasonsData"][s]["regularGames"]:
        a, b = g["a"], g["b"]
        if divmap.get(a["uid"]) and divmap[a["uid"]] == divmap.get(b["uid"]):
            if a["pts"] > b["pts"]:
                recs[a["uid"]]["divW"] += 1; recs[b["uid"]]["divL"] += 1
            elif b["pts"] > a["pts"]:
                recs[b["uid"]]["divW"] += 1; recs[a["uid"]]["divL"] += 1
    div_out[s] = {"records": dict(recs), "divisions": divmap}

# ---------------- pick trade ledger ----------------
pick_ledger = {}
for s in SEASONS:
    rows = []
    for tp in load(f"traded_picks_{s}.json"):
        # roster ids here refer to the league-year the pick BELONGS to; map via that season if we have it
        season_of_pick = tp["season"]
        mapping = r2u.get(season_of_pick) or r2u[s]
        rows.append({"pickSeason": season_of_pick, "round": tp["round"],
                     "origUid": mapping.get(tp["roster_id"]),
                     "fromUid": mapping.get(tp["previous_owner_id"]),
                     "toUid": mapping.get(tp["owner_id"])})
    pick_ledger[s] = rows

# draft board "via" annotations: slot owner != drafter (draft_order maps user_id -> slot)
draft_via = {}
for s in SEASONS:
    for d in load(f"draft_picks_{s}.json"):
        order = d["draft"].get("draft_order") or {}
        slot_owner = {slot: uid for uid, slot in order.items()}
        for p in d["picks"]:
            orig_uid = slot_owner.get(p.get("draft_slot"))
            drafter = p.get("picked_by") or r2u[s].get(p.get("roster_id"))
            if orig_uid and drafter and orig_uid != drafter:
                draft_via.setdefault(s, {})[str(p["pick_no"])] = orig_uid

# ---------------- superlatives ----------------
def _career_games(uid):
    out = []
    for s in COMPLETE:
        for g in DATA["seasonsData"][s]["regularGames"]:
            for side, other in (("a", "b"), ("b", "a")):
                if g[side]["uid"] == uid:
                    out.append((g[side]["pts"], g[other]["pts"]))
    return out

active_uids = [u for u in DATA["career"] if CURRENT in DATA["managers"][u]["seasons"]]
superlatives = []
def crown(icon, title, uid, value, desc):
    superlatives.append({"icon": icon, "title": title, "uid": uid, "value": value, "desc": desc})

faab_total = defaultdict(int)
for s, m in faab_season.items():
    for uid, amt in m.items():
        faab_total[uid] += amt
if faab_total:
    u = max(faab_total, key=faab_total.get)
    crown("🎰", "The Gambler", u, f"${faab_total[u]}", "most FAAB torched all-time")

eligible = {u: c for u, c in lineup_career.items() if c["weeks"] >= 20}
if eligible:
    u = min(eligible, key=lambda x: eligible[x]["act"] / eligible[x]["opt"])
    crown("😴", "The Sleepwalker", u, f"{eligible[u]['act'] / eligible[u]['opt'] * 100:.1f}%",
          "worst lineup efficiency (min 20 games)")

stats_by_uid = {}
for u in active_uids:
    gs = _career_games(u)
    if len(gs) < 14: continue
    losses = [p for p, o in gs if p < o]
    mean = sum(p for p, _ in gs) / len(gs)
    sd = (sum((p - mean) ** 2 for p, _ in gs) / (len(gs) - 1)) ** 0.5
    stats_by_uid[u] = {
        "lossPPG": sum(losses) / len(losses) if losses else 0, "sd": sd,
        "closeW": sum(1 for p, o in gs if 0 < p - o < 5),
        "closeL": sum(1 for p, o in gs if 0 < o - p < 5),
    }
if stats_by_uid:
    u = max(stats_by_uid, key=lambda x: stats_by_uid[x]["lossPPG"])
    crown("💔", "Glass Cannon", u, f"{stats_by_uid[u]['lossPPG']:.1f} PPG", "highest scoring average in losses")
    u = max(stats_by_uid, key=lambda x: stats_by_uid[x]["sd"])
    crown("🎢", "Boom or Bust", u, f"±{stats_by_uid[u]['sd']:.1f}", "wildest week-to-week scoring swings")
    u = min(stats_by_uid, key=lambda x: stats_by_uid[x]["sd"])
    crown("🎯", "The Metronome", u, f"±{stats_by_uid[u]['sd']:.1f}", "most consistent scorer")
    u = max(stats_by_uid, key=lambda x: stats_by_uid[x]["closeW"])
    crown("🗡️", "The Assassin", u, f"{stats_by_uid[u]['closeW']} wins", "most wins by fewer than 5 points")
    u = max(stats_by_uid, key=lambda x: stats_by_uid[x]["closeL"])
    crown("🪦", "Heartbreak Kid", u, f"{stats_by_uid[u]['closeL']} losses", "most losses by fewer than 5 points")

pickup_total = defaultdict(float)
for p in pickups:
    pickup_total[p["uid"]] += p["pts"]
if pickup_total:
    u = max(pickup_total, key=pickup_total.get)
    crown("🦅", "The Vulture", u, f"{pickup_total[u]:.0f} pts", "most points scavenged off waivers & free agency")

div_pct = {}
for s, dd in div_out.items():
    for uid, r in dd["records"].items():
        agg = div_pct.setdefault(uid, [0, 0])
        agg[0] += r["divW"]; agg[1] += r["divL"]
if div_pct:
    u = max(div_pct, key=lambda x: div_pct[x][0] / max(1, div_pct[x][0] + div_pct[x][1]))
    crown("🏘️", "The Bully", u, f"{div_pct[u][0]}-{div_pct[u][1]}", "best divisional record all-time")

# ---------------- championship plaques ----------------
plaques = {}
for s in COMPLETE:
    sd = DATA["seasonsData"][s]
    champ = sd["champion"]
    title_game = next((g for g in sd["playoffGames"] if g["type"] == "championship"), None)
    if not champ or not title_game:
        continue
    rid = u2r[s][champ]
    row = week_rows.get((s, title_game["week"]), {}).get(rid)
    if not row:
        continue
    plaques[s] = {"uid": champ,
                  "score": f'{title_game["a"]["pts"]}–{title_game["b"]["pts"]}' if title_game["a"]["uid"] == champ
                           else f'{title_game["b"]["pts"]}–{title_game["a"]["pts"]}',
                  "opp": title_game["b"]["uid"] if title_game["a"]["uid"] == champ else title_game["a"]["uid"],
                  "lineup": [{"pid": pid, "slot": SLOTS[i] if i < len(SLOTS) else "?",
                              "pts": round((row.get("players_points") or {}).get(pid) or 0, 2)}
                             for i, pid in enumerate(row.get("starters") or [])]}

# ---------------- revenge-game map ----------------
former_teams = defaultdict(set)
for (uid, pid), wks in rostered_wks.items():
    if wks >= 2:
        former_teams[pid].add(uid)
former_out = {pid: sorted(uids) for pid, uids in former_teams.items() if len(uids) >= 1}

# ---------------- Elo ratings ----------------
# K=32, all regular-season + bracket games in chronological order, ratings carry across seasons.
elo = defaultdict(lambda: 1500.0)
elo_hist = {"weeks": [], "series": defaultdict(list)}
elo_peak = {}
all_uids_ever = set()
for s in SEASONS:
    sd = DATA["seasonsData"][s]
    season_uids = {st["uid"] for st in sd["standings"]}
    all_uids_ever |= season_uids
    games_by_week = defaultdict(list)
    for g in sd["regularGames"] + sd["playoffGames"]:
        games_by_week[g["week"]].append(g)
    for wk in sorted(games_by_week):
        for g in games_by_week[wk]:
            a, b = g["a"]["uid"], g["b"]["uid"]
            if g["type"] == "regular":
                if g["a"]["pts"] == g["b"]["pts"]:
                    sa = 0.5
                else:
                    sa = 1.0 if g["a"]["pts"] > g["b"]["pts"] else 0.0
            else:
                sa = 1.0 if g.get("winner") == a else 0.0
            ea = 1.0 / (1.0 + 10 ** ((elo[b] - elo[a]) / 400.0))
            elo[a] += 32 * (sa - ea)
            elo[b] += 32 * ((1 - sa) - (1 - ea))
        elo_hist["weeks"].append(f"{s} wk{wk}")
        for uid in all_uids_ever:
            r = round(elo[uid], 1) if uid in season_uids else None
            elo_hist["series"][uid].append(r)
            if r is not None and (uid not in elo_peak or r > elo_peak[uid][0]):
                elo_peak[uid] = (r, f"{s} wk{wk}")
# pad the front of series for managers who joined later
n_pts = len(elo_hist["weeks"])
for uid in elo_hist["series"]:
    ser = elo_hist["series"][uid]
    if len(ser) < n_pts:
        elo_hist["series"][uid] = [None] * (n_pts - len(ser)) + ser
elo_out = {
    "weeks": elo_hist["weeks"],
    "series": {u: v for u, v in elo_hist["series"].items()},
    "table": sorted([{"uid": u, "elo": round(elo[u], 1),
                      "peak": elo_peak[u][0], "peakWhen": elo_peak[u][1],
                      "active": CURRENT in DATA["managers"][u]["seasons"]}
                     for u in elo_hist["series"]], key=lambda x: -x["elo"]),
}

# ---------------- player passports ----------------
# every player's full league history: draft, trades, adds/drops, stints per owner
pass_events = defaultdict(list)
for s in SEASONS:
    for d in load(f"draft_picks_{s}.json"):
        for p in d["picks"]:
            uid = p.get("picked_by") or r2u[s].get(p.get("roster_id"))
            if uid:
                pass_events[p["player_id"]].append(
                    {"t": "draft", "season": s, "week": 0, "uid": uid,
                     "pick": f'{p["round"]}.{p["pick_no"] - (p["round"] - 1) * 8:02d}'})
    for t in load(f"transactions_{s}.json"):
        if t["status"] != "complete":
            continue
        wk = t.get("leg") or 1
        if t["type"] == "trade":
            for pid, rid in (t.get("adds") or {}).items():
                frm = (t.get("drops") or {}).get(pid)
                pass_events[pid].append({"t": "trade", "season": s, "week": wk,
                                         "uid": r2u[s][rid],
                                         "from": r2u[s].get(frm) if frm else None})
        else:
            bid = ((t.get("settings") or {}).get("waiver_bid") or 0) if t["type"] == "waiver" else 0
            for pid, rid in (t.get("adds") or {}).items():
                pass_events[pid].append({"t": "add", "season": s, "week": wk,
                                         "uid": r2u[s][rid], "bid": bid, "kind": t["type"]})
            for pid, rid in (t.get("drops") or {}).items():
                pass_events[pid].append({"t": "drop", "season": s, "week": wk, "uid": r2u[s][rid]})

# stints: contiguous ownership runs across all weeks with data
stints = defaultdict(list)   # pid -> [{uid, from, to, weeks, pts}]
owner_by_week = defaultdict(list)  # pid -> [(season, week, uid)]
for (s, w) in ALL_WEEKS:
    rows = week_rows.get((s, w), {})
    for rid, row in rows.items():
        if (w, rid) not in counted[s]:
            continue  # only weeks actually played — keeps stints/tenure honest
        uid = r2u[s][rid]
        starters = set(row.get("starters") or [])
        for pid in row.get("players") or []:
            owner_by_week[pid].append((s, w, uid,
                (row.get("players_points") or {}).get(pid) or 0 if pid in starters else 0))
for pid, seq in owner_by_week.items():
    run = None
    for (s, w, uid, pts) in seq:
        if run and run["uid"] == uid:
            run["to"] = f"{s} wk{w}"; run["weeks"] += 1; run["pts"] += pts
        else:
            if run:
                stints[pid].append(run)
            run = {"uid": uid, "from": f"{s} wk{w}", "to": f"{s} wk{w}", "weeks": 1, "pts": pts}
    if run:
        stints[pid].append(run)

passports = {}
for pid in set(list(pass_events.keys()) + list(stints.keys())):
    evs = sorted(pass_events.get(pid, []), key=lambda e: (e["season"], e["week"]))
    st = [{**x, "pts": round(x["pts"], 1)} for x in stints.get(pid, [])]
    owner = next((u for u, ps in current_roster.items() if pid in ps), None)
    if not evs and not st:
        continue
    passports[pid] = {"events": evs, "stints": st, "owner": owner,
                      "owners": len({x["uid"] for x in st}) or len({e["uid"] for e in evs})}

# ---------------- records watch ----------------
watch = []
career = DATA["career"]
names = {u: DATA["managers"][u]["name"] for u in DATA["managers"]}
active = [u for u in career if CURRENT in DATA["managers"][u]["seasons"]]
by_wins = sorted(active, key=lambda u: -career[u]["w"])
for a, b in zip(by_wins, by_wins[1:]):
    gap = career[a]["w"] - career[b]["w"]
    if 0 < gap <= 5:
        watch.append({"icon": "🏁", "text": f"{names[b]} trails {names[a]} by {gap} career win{'s' if gap > 1 else ''} ({career[b]['w']} vs {career[a]['w']})"})
h2h = DATA["h2h"]
for a in active:
    for b in active:
        if a >= b: continue
        r = h2h.get(a, {}).get(b)
        if not r: continue
        aw, al = r["w"] + r["pw"], r["l"] + r["pl"]
        if aw + al >= 4 and al == 0:
            watch.append({"icon": "😈", "text": f"{names[a]} has NEVER lost to {names[b]} ({aw}-0 all-time) — the streak is on the line this season"})
        elif aw + al >= 4 and aw == 0:
            watch.append({"icon": "😈", "text": f"{names[a]} has never beaten {names[b]} (0-{al} all-time)"})
champ_counts = sorted(((len(career[u]["champs"]), u) for u in active), reverse=True)
if champ_counts[0][0] >= 1:
    lead = champ_counts[0]
    chasers = [u for n, u in champ_counts[1:] if n == lead[0] - 1]
    for u in chasers:
        watch.append({"icon": "🏆", "text": f"{names[u]} is one title behind {names[lead[1]]} ({lead[0] - 1} vs {lead[0]})"})
cs = DATA["currentStreaks"]
for u in active:
    st = cs.get(u)
    if st and st["n"] >= 4:
        kind = "win" if st["kind"] == "W" else "losing"
        watch.append({"icon": "♨️" if st["kind"] == "W" else "🥶", "text": f"{names[u]} carries a {st['n']}-game {kind} streak into {CURRENT}"})
rec_streak = max(DATA["streaks"].items(), key=lambda kv: kv[1]["maxL"])
watch.append({"icon": "📜", "text": f"All-time records to beat: {DATA['records']['highScores'][0]['pts']} pts in a week ({names[DATA['records']['highScores'][0]['uid']]}), {rec_streak[1]['maxL']}-game skid ({names[rec_streak[0]]})"})

# ---------------- player name map (only ids referenced anywhere) ----------------
used = set()
for lst in (top_starters, top_benched):
    used.update(x["pid"] for x in lst)
for f in franchise.values():
    used.update(x["pid"] for x in f["legends"] + f["bestSeasons"] + f["tenure"])
for pl in plaques.values():
    used.update(x["pid"] for x in pl["lineup"])
used.update(passports.keys())
for s in SEASONS:
    for wa in weekly_awards[s].values():
        if "topPid" in wa: used.add(wa["topPid"])
        if "benchPid" in wa: used.add(wa["benchPid"])
# every player who ever appeared on a roster (for live recaps + projections)
for (s, wk), rows in week_rows.items():
    for row in rows.values():
        used.update(row.get("players") or [])
player_names = {pid: [name_of(pid), pos_of(pid)] for pid in used}

payload = {
    "playerNames": player_names,
    "lineup": {"career": lineup_out, "worstBenchings": worst_benchings,
               "lostByBench": lost_by_bench[:12]},
    "playerRecords": {"topStarters": top_starters, "topBenched": top_benched},
    "weeklyAwards": {s: weekly_awards[s] for s in SEASONS},
    "trades": trades_out,
    "faab": {"perSeason": {s: faab_season[s] for s in faab_season},
             "topBids": top_bids[:10], "budget": chain[CURRENT]["settings"].get("waiver_budget", 100)},
    "pickups": pickups[:15],
    "divisions": div_out,
    "pickLedger": pick_ledger,
    "draftVia": draft_via,
    "recordsWatch": watch,
    "kickoff": "2026-09-10T20:20:00-04:00",
    "franchise": franchise,
    "tenureLeaders": tenure_out,
    "whatIf": what_if,
    "superlatives": superlatives,
    "plaques": plaques,
    "formerTeams": former_out,
    "elo": elo_out,
    "passports": passports,
}
out = os.path.join(HERE, "assets", "extras.js")
with open(out, "w") as f:
    f.write("window.LEAGUE_EXTRAS = ")
    json.dump(payload, f)
    f.write(";\n")
print("Wrote", out, os.path.getsize(out) // 1024, "KB")
print("trades:", len(trades_out), "| pickups:", len(pickups), "| watch items:", len(watch),
      "| players named:", len(player_names))
