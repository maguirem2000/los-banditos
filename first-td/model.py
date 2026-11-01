"""
First Touchdown Scorer model (first TD of the game).

P(player scores the game's first TD) =
    P(game has a TD)
  x P(player's team scores the first TD | a TD happens)       <- team model
  x P(offensive TD, not DEF/ST | team scores first)          <- DST model
  x P(it's this player | team's first offensive TD)          <- player share model

Data: nflverse play-by-play (2018+), schedule w/ Vegas lines, weekly rosters,
official injury reports, ESPN depth charts.
"""
import math
import numpy as np
import pandas as pd

import os
DATA = os.environ.get("FTD_DATA", os.path.join(os.path.dirname(os.path.abspath(__file__)), ".data"))
SEASONS = list(range(2018, 2027))
PBP_COLS = ['play_id', 'game_id', 'season', 'week', 'season_type', 'posteam', 'defteam',
            'home_team', 'away_team', 'td_team', 'td_player_id', 'td_player_name',
            'return_touchdown', 'rusher_player_id', 'rusher_player_name', 'receiver_player_id',
            'receiver_player_name', 'yardline_100', 'play_type', 'qtr', 'fixed_drive',
            'epa', 'pass_attempt', 'rush_attempt', 'two_point_attempt', 'qb_kneel', 'qb_spike']

POS_GROUP = {'QB': 'QB', 'RB': 'RB', 'FB': 'RB', 'WR': 'WR', 'TE': 'TE'}
# per-game TD-rate priors by position & depth rank (used for low-sample players)
PRIOR = {('QB', 1): .14, ('QB', 2): .02, ('RB', 1): .42, ('RB', 2): .17, ('RB', 3): .06,
         ('WR', 1): .36, ('WR', 2): .24, ('WR', 3): .14, ('WR', 4): .05,
         ('TE', 1): .22, ('TE', 2): .08, ('TE', 3): .03}
DEFAULT_PRIOR = .03


def prior_for(pos, rank):
    return PRIOR.get((pos, int(rank) if rank and not pd.isna(rank) else 9), DEFAULT_PRIOR)


# ---------------------------------------------------------------- loading
def load_pbp():
    frames = []
    for s in SEASONS:
        p = pd.read_parquet(f"{DATA}/pbp_{s}.parquet", columns=PBP_COLS)
        frames.append(p[p.season_type == 'REG'])
    pbp = pd.concat(frames, ignore_index=True)
    pbp['play_id'] = pbp.play_id.astype(float)
    return pbp


def load_games():
    g = pd.read_csv(f"{DATA}/games.csv")
    g = g[(g.season.isin(SEASONS)) & (g.game_type == 'REG')].copy()
    # nflverse spread_line > 0 means home favoured
    g['home_imp'] = (g.total_line + g.spread_line) / 2
    g['away_imp'] = (g.total_line - g.spread_line) / 2
    return g


# ---------------------------------------------------------------- per-game facts
def game_facts(pbp):
    """First TD of each game + team-level per-game logs."""
    tds = pbp[pbp.td_team.notna()].sort_values(['game_id', 'play_id'])
    tds = tds.assign(off=(tds.td_team == tds.posteam) & (tds.return_touchdown != 1))
    first = tds.groupby('game_id').head(1).set_index('game_id')

    # team first-drive (opening possession) TD and first-quarter TDs
    meta = pbp.groupby('game_id').agg(season=('season', 'first'), week=('week', 'first'),
                                      home=('home_team', 'first'), away=('away_team', 'first'))
    rows = []
    q1c = tds[tds.qtr == 1].groupby(['game_id', 'td_team']).size().to_dict()
    off_drives = pbp[pbp.posteam.notna() & pbp.fixed_drive.notna()]
    first_drive = off_drives.groupby(['game_id', 'posteam']).fixed_drive.min()
    drive_td = tds[tds.off].groupby(['game_id', 'td_team']).fixed_drive.apply(set)
    for gid, m in meta.iterrows():
        f = first.loc[gid] if gid in first.index else None
        for team, opp, is_home in ((m.home, m.away, 1), (m.away, m.home, 0)):
            fd = first_drive.get((gid, team), np.nan)
            dset = drive_td.get((gid, team), set())
            rows.append(dict(game_id=gid, season=m.season, week=m.week, team=team, opp=opp,
                             home=is_home,
                             first_td=int(f is not None and f.td_team == team),
                             first_td_off=int(f is not None and f.td_team == team and f.off),
                             open_drive_td=int(fd in dset),
                             q1_td=int(q1c.get((gid, team), 0)),
                             ))
    tl = pd.DataFrame(rows)
    # total TDs, offensive TDs, dst TDs per team-game
    agg = tds.groupby(['game_id', 'td_team']).agg(tds=('off', 'size'), off_tds=('off', 'sum')).reset_index()
    agg = agg.rename(columns={'td_team': 'team'})
    tl = tl.merge(agg, on=['game_id', 'team'], how='left').fillna({'tds': 0, 'off_tds': 0})
    tl['dst_tds'] = tl.tds - tl.off_tds
    # EPA/play
    plays = pbp[(pbp.pass_attempt == 1) | (pbp.rush_attempt == 1)]
    plays = plays[(plays.two_point_attempt != 1) & (plays.qb_kneel != 1) & (plays.qb_spike != 1)]
    epa = plays.groupby(['game_id', 'posteam']).agg(off_epa=('epa', 'sum'), off_plays=('epa', 'size')).reset_index()
    tl = tl.merge(epa.rename(columns={'posteam': 'team'}), on=['game_id', 'team'], how='left')
    depa = epa.rename(columns={'posteam': 'opp', 'off_epa': 'def_epa', 'off_plays': 'def_plays'})
    tl = tl.merge(depa, on=['game_id', 'opp'], how='left')
    # red-zone trips/TDs
    rz = pbp[(pbp.yardline_100 <= 20) & pbp.posteam.notna() & pbp.fixed_drive.notna()]
    trips = rz.groupby(['game_id', 'posteam']).fixed_drive.nunique().rename('rz_trips').reset_index()
    tl = tl.merge(trips.rename(columns={'posteam': 'team'}), on=['game_id', 'team'], how='left').fillna({'rz_trips': 0})
    # opponent mirror of TDs allowed
    opp_side = tl[['game_id', 'team', 'tds', 'off_tds', 'q1_td', 'first_td']].rename(
        columns={'team': 'opp', 'tds': 'tds_allowed', 'off_tds': 'off_tds_allowed',
                 'q1_td': 'q1_td_allowed', 'first_td': 'opp_first_td'})
    tl = tl.merge(opp_side, on=['game_id', 'opp'], how='left')
    tl['gkey'] = tl.season * 100 + tl.week
    first = first.assign(off=first.off.astype(int))
    return tl, first


# ---------------------------------------------------------------- player logs
def build_xtd_table(pbp):
    """League TD probability per opportunity by type & yardline bucket."""
    bins = [0, 2, 5, 10, 20, 40, 100]
    o = opportunities(pbp)
    o['bucket'] = pd.cut(o.yardline_100, bins, labels=False)
    tab = o.groupby(['kind', 'bucket']).td.mean()
    return tab, bins


def opportunities(pbp):
    base = pbp[(pbp.two_point_attempt != 1) & pbp.posteam.notna() & pbp.yardline_100.notna()]
    tdp = base.td_player_id.where((base.td_team == base.posteam) & (base.return_touchdown != 1))
    r = base[base.rusher_player_id.notna() & (base.qb_kneel != 1)]
    rush = pd.DataFrame(dict(game_id=r.game_id, season=r.season, week=r.week, team=r.posteam, opp=r.defteam,
                             pid=r.rusher_player_id, name=r.rusher_player_name, kind='rush',
                             yardline_100=r.yardline_100, fixed_drive=r.fixed_drive,
                             td=(tdp.loc[r.index] == r.rusher_player_id).astype(int)))
    t = base[base.receiver_player_id.notna()]
    tgt = pd.DataFrame(dict(game_id=t.game_id, season=t.season, week=t.week, team=t.posteam, opp=t.defteam,
                            pid=t.receiver_player_id, name=t.receiver_player_name, kind='tgt',
                            yardline_100=t.yardline_100, fixed_drive=t.fixed_drive,
                            td=(tdp.loc[t.index] == t.receiver_player_id).astype(int)))
    return pd.concat([rush, tgt], ignore_index=True)


def player_game_logs(pbp, first, xtab, bins):
    o = opportunities(pbp)
    o['bucket'] = pd.cut(o.yardline_100, bins, labels=False)
    o['xtd'] = [xtab.get((k, b), 0) for k, b in zip(o.kind, o.bucket)]
    # early = team's first two offensive drives of the game
    fd = pbp[pbp.posteam.notna() & pbp.fixed_drive.notna()].groupby(['game_id', 'posteam']).fixed_drive.unique()
    early_map = {k: set(sorted(v)[:2]) for k, v in fd.items()}
    o['early'] = [d in early_map.get((g, t), ()) for g, t, d in zip(o.game_id, o.team, o.fixed_drive)]
    o['early_xtd'] = o.xtd * o.early
    o['rz'] = (o.yardline_100 <= 20).astype(int)
    o['i10'] = (o.yardline_100 <= 10).astype(int)
    logs = o.groupby(['game_id', 'season', 'week', 'team', 'opp', 'pid']).agg(
        name=('name', 'last'), xtd=('xtd', 'sum'), early_xtd=('early_xtd', 'sum'),
        rz=('rz', 'sum'), i10=('i10', 'sum'), opps=('xtd', 'size')).reset_index()
    # actual offensive TDs (any play incl. fumble recoveries) by scorer
    td = pbp[pbp.td_team.notna() & (pbp.td_team == pbp.posteam) & (pbp.return_touchdown != 1)]
    tdc = td.groupby(['game_id', 'td_player_id']).size().rename('tds').reset_index().rename(columns={'td_player_id': 'pid'})
    logs = logs.merge(tdc, on=['game_id', 'pid'], how='left').fillna({'tds': 0})
    # team-first & game-first TD flags
    tds_sorted = td.sort_values(['game_id', 'play_id'])
    team_first = tds_sorted.groupby(['game_id', 'td_team']).head(1)[['game_id', 'td_player_id']]
    team_first = set(zip(team_first.game_id, team_first.td_player_id))
    logs['team_first'] = [int((g, p) in team_first) for g, p in zip(logs.game_id, logs.pid)]
    gf = first[first.off == 1].td_player_id.to_dict()
    logs['game_first'] = [int(gf.get(g) == p) for g, p in zip(logs.game_id, logs.pid)]
    logs['gkey'] = logs.season * 100 + logs.week
    hm = pbp.groupby('game_id').home_team.first()
    logs['home'] = (logs.team.values == hm.reindex(logs.game_id).values).astype(int)
    return logs


# ---------------------------------------------------------------- decayed helpers
def decay_weights(df, asof_key, half_life_games=8, season_discount=0.65, by='team'):
    """Exponential decay by recency (game index within entity) + cross-season discount."""
    df = df[df.gkey < asof_key].copy()
    asof_season = asof_key // 100
    df = df.sort_values('gkey')
    df['ago'] = df.groupby(by).cumcount(ascending=False)
    df['w'] = 0.5 ** (df.ago / half_life_games) * season_discount ** (asof_season - df.season)
    return df


def team_features(tl, asof_key):
    d = decay_weights(tl, asof_key, half_life_games=8, season_discount=0.55, by='team')
    d = d[d.season >= asof_key // 100 - 2]
    cols = ['first_td', 'first_td_off', 'open_drive_td', 'q1_td', 'tds', 'off_tds', 'dst_tds',
            'tds_allowed', 'q1_td_allowed', 'opp_first_td', 'off_epa', 'off_plays', 'def_epa', 'def_plays',
            'rz_trips', 'off_tds_allowed']
    wsum = d.groupby('team').w.sum()
    out = pd.DataFrame({c: (d[c].fillna(0) * d.w).groupby(d.team).sum() for c in cols})
    out['w'] = wsum
    return out


def shrink(num, den, prior, k):
    return (num + prior * k) / (den + k)


# ---------------------------------------------------------------- team model
TEAM_FEATS = ['imp_diff', 'ftd_diff', 'q1_diff', 'odt_diff', 'home']


def team_row(feat, team, opp, imp_team, imp_opp, home, lg):
    a, b = feat.loc[team], feat.loc[opp]
    ftd_a = shrink(a.first_td, a.w, .5, 6)
    ftd_b = shrink(b.first_td, b.w, .5, 6)
    q1_a = shrink(a.q1_td + b.q1_td_allowed, a.w + b.w, lg['q1'], 6)
    q1_b = shrink(b.q1_td + a.q1_td_allowed, a.w + b.w, lg['q1'], 6)
    od_a = shrink(a.open_drive_td, a.w, lg['odt'], 6)
    od_b = shrink(b.open_drive_td, b.w, lg['odt'], 6)
    return dict(imp_diff=(imp_team - imp_opp) / 7, ftd_diff=ftd_a - ftd_b, q1_diff=q1_a - q1_b,
                odt_diff=od_a - od_b, home=home)


def league_consts(tl, asof_key):
    d = tl[(tl.gkey < asof_key) & (tl.season >= asof_key // 100 - 3)]
    return dict(q1=d.q1_td.mean(), odt=d.open_drive_td.mean(), dst=d.dst_tds.mean(),
                tds=d.tds.mean(), dst_first=(d.first_td - d.first_td_off).sum() / max(d.first_td.sum(), 1))


def team_design(tl, games, first, keys):
    """Rows (one per game, from home perspective) for fitting/evaluating the team model."""
    rows = []
    for key in keys:
        feat = team_features(tl, key)
        lg = league_consts(tl, key)
        gg = games[(games.season * 100 + games.week) == key]
        for _, g in gg.iterrows():
            if g.home_team not in feat.index or g.away_team not in feat.index or pd.isna(g.total_line):
                continue
            r = team_row(feat, g.home_team, g.away_team, g.home_imp, g.away_imp, 1, lg)
            f = first.loc[g.game_id] if g.game_id in first.index else None
            r.update(game_id=g.game_id, key=key, total=g.total_line,
                     y=(None if f is None else int(f.td_team == g.home_team)),
                     notd=int(f is None) if not pd.isna(g.home_score) else None)
            rows.append(r)
    return pd.DataFrame(rows)


# ---------------------------------------------------------------- player model
def player_table(logs, asof_key, roster, depth, opp_pos_def, params):
    """Per-player base weights for team share (before opponent/injury/home adjustments)."""
    d = decay_weights(logs, asof_key, half_life_games=params['hl'], season_discount=0.6, by='pid')
    d = d[d.season >= asof_key // 100 - 2]
    w = d.w
    g = d.assign(wx=d.xtd * w, wt=d.tds * w, we=d.early_xtd * w,
                 wh=w * d.home, wth=d.tds * w * d.home, wxh=d.xtd * w * d.home)
    agg = g.groupby('pid').agg(wx=('wx', 'sum'), wt=('wt', 'sum'), we=('we', 'sum'), w=('w', 'sum'),
                               wh=('wh', 'sum'), wth=('wth', 'sum'), wxh=('wxh', 'sum'))
    r0 = agg.we.sum() / agg.wx.sum()
    res = roster.merge(agg, left_on='gsis_id', right_index=True, how='left').fillna(
        {'wx': 0, 'wt': 0, 'we': 0, 'w': 0, 'wh': 0, 'wth': 0, 'wxh': 0})
    res = res.merge(depth, on=['team', 'gsis_id'], how='left')
    pri = np.array([prior_for(p, rk) for p, rk in zip(res.pos, res.depth_rank)])
    a = params['actual_wt']
    k = params['prior_games']
    res['rate'] = (pri * k + a * res.wt + (1 - a) * res.wx) / (k + res.w)
    # early-drive (scripted) usage factor
    c = 0.6
    res['early_f'] = (((res.we + c * r0) / (res.wx + c)) / r0) ** params['early_beta']
    # home/away split factor (actual+expected TD rate at home vs overall), heavily shrunk
    home_rate = shrink(a * res.wth + (1 - a) * res.wxh, res.wh, res.rate, 6)
    away_rate = shrink(a * (res.wt - res.wth) + (1 - a) * (res.wx - res.wxh), res.w - res.wh, res.rate, 6)
    res['home_f'] = (home_rate / res.rate.clip(lower=1e-4)) ** params['ha_beta']
    res['away_f'] = (away_rate / res.rate.clip(lower=1e-4)) ** params['ha_beta']
    return res


def opp_position_defense(logs, roster_pos, asof_key):
    """TDs allowed by each defense to each position group, relative to league (shrunk)."""
    d = logs[(logs.gkey < asof_key) & (logs.season >= asof_key // 100 - 1)]
    d = d.merge(roster_pos, on='pid', how='left')
    d = d[d.pos.notna()]
    d['w'] = np.where(d.season == asof_key // 100, 1.0, 0.45)
    games = d.groupby(['opp', 'game_id']).w.first().groupby('opp').sum()
    val = (0.5 * d.tds + 0.5 * d.xtd) * d.w
    allowed = val.groupby([d.opp, d.pos]).sum().unstack(fill_value=0)
    per_g = allowed.div(games, axis=0)
    lg = allowed.sum() / games.sum()
    k = 6
    f = (allowed + lg * k).div(games + k, axis=0) / lg
    return f, per_g, lg


INJ_MULT = {'Out': 0.0, 'Doubtful': 0.15, 'Questionable': 0.88}
REDIST_SAME_POS = 0.65
OTHER_MASS = 0.035


def team_shares(players):
    """players: DataFrame for one team with columns w (adjusted weight), w0 (pre-injury), pos.
    Returns P(player | team's first offensive TD)."""
    p = players.copy()
    removed = (p.w0 - p.w).groupby(p.pos).sum()
    for pos, rem in removed.items():
        m = p.pos == pos
        tot = p.loc[m, 'w'].sum()
        if rem > 0 and tot > 0:
            p.loc[m, 'w'] += REDIST_SAME_POS * rem * p.loc[m, 'w'] / tot
    s = p.w.sum()
    return p.w / s * (1 - OTHER_MASS) if s > 0 else p.w * 0


def odds(p):
    if p <= 0:
        return None
    if p >= 1:
        return -100000
    return round(-100 * p / (1 - p)) if p >= .5 else round(100 * (1 - p) / p)
