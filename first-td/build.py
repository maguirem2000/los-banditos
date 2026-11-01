"""Build the weekly first-TD slate -> ftd_data.json (consumed by index.html)."""
import json, sys, datetime as dt
import numpy as np
import pandas as pd
from model import *
from backtest import prep, roster_for

SEASON = 2026
P = json.load(open('params.json'))
PP = P['player']


def sig(x):
    return 1 / (1 + math.exp(-x))


def latest_depth():
    d = pd.read_parquet(f"{DATA}/depth_{SEASON}.parquet")
    d = d[d.pos_abb.isin(['QB', 'RB', 'WR', 'TE'])]
    d = d[d.dt == d.groupby('team').dt.transform('max')]
    d = d.sort_values('pos_rank').drop_duplicates(['team', 'gsis_id'])
    return d[['team', 'gsis_id', 'pos_rank']].rename(columns={'pos_rank': 'depth_rank'})


def rank_of(series, ascending=False):
    return series.rank(ascending=ascending, method='min').astype(int)


def team_cards(tl, logs, rpos, key):
    s = tl[(tl.season == SEASON) & (tl.gkey < key)]
    g = s.groupby('team')
    c = pd.DataFrame(dict(
        gp=g.size(), off_tds=g.off_tds.mean(), tds_allowed=g.tds_allowed.mean(),
        off_epa=g.off_epa.sum() / g.off_plays.sum(), def_epa=g.def_epa.sum() / g.def_plays.sum(),
        rz_td=g.off_tds.sum() / g.rz_trips.sum().clip(lower=1),
        first_td=g.first_td.sum(), open_td=g.open_drive_td.mean(), q1=g.q1_td.mean(),
        q1_allowed=g.q1_td_allowed.mean(), opp_first=g.opp_first_td.sum(), dst=g.dst_tds.sum()))
    c['off_rank'] = rank_of(c.off_epa)
    c['def_rank'] = rank_of(c.def_epa, ascending=True)
    # TDs allowed by position (this season)
    l = logs[(logs.season == SEASON) & (logs.gkey < key)].merge(rpos, on='pid', how='left')
    allowed = l.groupby(['opp', 'pos']).tds.sum().unstack(fill_value=0)
    per = allowed.div(c.gp, axis=0).fillna(0)
    for pos in ['QB', 'RB', 'WR', 'TE']:
        c[f'allow_{pos}'] = per.get(pos, 0)
        c[f'allow_{pos}_rank'] = rank_of(c[f'allow_{pos}'])  # 1 = most generous
    rush = l[l.pos.isin(['RB', 'QB'])].groupby('opp').tds.sum()
    tot = l.groupby('opp').tds.sum()
    share = (rush / tot).reindex(c.index).fillna(.45)
    lg = rush.sum() / tot.sum()
    c['rush_share_allowed'] = share
    c['funnel'] = np.where(share > lg + .1, 'Run funnel', np.where(share < lg - .1, 'Pass funnel', 'Balanced'))
    # offense identity
    ol = l.groupby(['team', 'pos']).tds.sum().unstack(fill_value=0)
    rs = ((ol.get('RB', 0) + ol.get('QB', 0)) / ol.sum(axis=1)).reindex(c.index).fillna(.45)
    c['off_style'] = np.where(rs > lg + .1, 'Run-heavy TDs', np.where(rs < lg - .1, 'Pass-heavy TDs', 'Balanced TDs'))
    return c


def recent_first(tl, logs, team, key, n=6):
    s = logs[(logs.team == team) & (logs.team_first == 1) & (logs.gkey < key)].sort_values('gkey').tail(n)
    games = tl[(tl.team == team) & (tl.gkey < key)].sort_values('gkey').tail(n)
    out = []
    for _, gm in games.iterrows():
        r = s[s.game_id == gm.game_id]
        out.append(dict(wk=f"{gm.season % 100}-W{gm.week}", opp=gm.opp, home=int(gm.home),
                        who=(r.name.iloc[0] if len(r) else ('DEF/ST' if gm.tds > gm.off_tds and gm.off_tds == 0 else '—')),
                        game_first=int(gm.first_td)))
    return out


def player_stats(logs, key):
    l = logs[logs.gkey < key]
    cur = l[l.season == SEASON]
    car = l[l.season >= SEASON - 3]

    def agg(df, sfx):
        g = df.groupby('pid')
        return pd.DataFrame({f'gp{sfx}': g.size(), f'td{sfx}': g.tds.sum(), f'tdg{sfx}': (g.tds.apply(lambda x: (x > 0).sum())),
                             f'tf{sfx}': g.team_first.sum(), f'gf{sfx}': g.game_first.sum(), f'xtd{sfx}': g.xtd.sum(),
                             f'rz{sfx}': g.rz.sum(), f'i10{sfx}': g.i10.sum()})
    a = agg(cur, '_s').join(agg(car, '_c'), how='outer')
    h = car.groupby(['pid', 'home']).agg(gp=('tds', 'size'), tdg=('tds', lambda x: (x > 0).sum())).unstack(fill_value=0)
    a['home_gp'] = h[('gp', 1)] if ('gp', 1) in h else 0
    a['home_tdg'] = h[('tdg', 1)] if ('tdg', 1) in h else 0
    a['away_gp'] = h[('gp', 0)] if ('gp', 0) in h else 0
    a['away_tdg'] = h[('tdg', 0)] if ('tdg', 0) in h else 0
    last5 = l.sort_values('gkey').groupby('pid').tail(5).groupby('pid').tds.apply(lambda x: ''.join('1' if v > 0 else '0' for v in x))
    a['last5'] = last5
    # team RZ share this season
    trz = cur.groupby('team').rz.sum()
    last_team = cur.sort_values('gkey').groupby('pid').team.last()
    a['rz_share'] = (a.rz_s / trz.reindex(last_team.reindex(a.index)).values).fillna(0)
    return a.fillna(0)


def build_week(d, week, use_injuries=True):
    key = SEASON * 100 + week
    games, tl, logs, first = d['games'], d['tl'], d['logs'], d['first']
    roster_week = min(week, int(pd.read_parquet(f"{DATA}/roster_weekly_{SEASON}.parquet").week.max()))
    ro = roster_for(SEASON, roster_week)
    if not use_injuries or roster_week != week:
        ro['report_status'] = np.nan  # injury report not out yet for this week
        inj_note = f"Week {week} injury report not released yet — only IR/inactive roster moves applied."
    else:
        inj_note = f"Official Week {week} injury report applied (Out removed, Doubtful/Questionable discounted)."
    ro = ro[ro.status.isin(['ACT', 'RES', 'INA'])]
    dep = latest_depth()
    rpos = ro[['gsis_id', 'pos']].rename(columns={'gsis_id': 'pid'}).drop_duplicates('pid')
    # include historical positions for players no longer rostered (for defense-vs-position)
    oppf, opp_per, lg_pos = opp_position_defense(logs, rpos, key)
    res = player_table(logs, key, ro, dep, None, PP)
    res['depth_rank'] = res.depth_rank.fillna(9)
    # raw (un-exponentiated) factors so the UI can re-weight them
    raw = player_table(logs, key, ro, dep, None, dict(PP, early_beta=1, ha_beta=1))
    res['early_raw'], res['home_raw'], res['away_raw'] = raw.early_f.values, raw.home_f.values, raw.away_f.values
    st = player_stats(logs, key)
    cards = team_cards(tl, logs, rpos, key)
    feat = team_features(tl, key)
    lgc = league_consts(tl, key)
    gg = games[(games.season == SEASON) & (games.week == week)]
    out_games = []
    for _, g in gg.iterrows():
        h, a = g.home_team, g.away_team
        x = (g.home_imp - g.away_imp) / 7 if not pd.isna(g.total_line) else 0
        tc = P['team_coef']
        p_home = sig(P['team_int'] + tc['imp_diff'] * x + tc['home'] * 1)
        total = g.total_line if not pd.isna(g.total_line) else 44
        p_notd = sig(P['notd_int'] + P['notd_coef'] * total)
        teams = []
        for team, opp, is_home, pt in ((a, h, 0, 1 - p_home), (h, a, 1, p_home)):
            # DEF/ST share of this team's first TD: own DEF/ST TD rate x opponent giveaway rate
            f, o = feat.loc[team], feat.loc[opp]
            own = shrink(f.dst_tds, f.w, lgc['dst'], 16) / lgc['dst']
            give = shrink(o.tds_allowed - o.off_tds_allowed, o.w, lgc['dst'], 16) / lgc['dst']
            dst_share = float(np.clip(lgc['dst_first'] * math.sqrt(own * give), .01, .15))
            p = res[(res.team == team)].copy()
            p = p[(p.wx > 0) | (p.depth_rank <= 3)]
            plist = []
            for _, r in p.iterrows():
                s = st.loc[r.gsis_id] if r.gsis_id in st.index else None
                oraw = float(oppf.loc[opp, r.pos]) if opp in oppf.index and r.pos in oppf.columns else 1.0
                inj = r.report_status if isinstance(r.report_status, str) else None
                if r.status != 'ACT':
                    inj = {'RES': 'IR', 'INA': 'Inactive'}.get(r.status, r.status)
                sd = lambda k: (float(s[k]) if s is not None else 0.0)
                plist.append(dict(
                    id=r.gsis_id, name=r['name'], pos=r.pos, depth=int(r.depth_rank), inj=inj,
                    rate=round(float(r.rate), 4), early=round(float(r.early_raw), 3),
                    ha=round(float(r.home_raw if is_home else r.away_raw), 3), opp=round(oraw, 3),
                    gp_s=int(sd('gp_s')), td_s=int(sd('td_s')), tdg_s=int(sd('tdg_s')), tf_s=int(sd('tf_s')),
                    gf_s=int(sd('gf_s')), xtd_s=round(sd('xtd_s'), 2), rz_s=int(sd('rz_s')), i10_s=int(sd('i10_s')),
                    rz_share=round(sd('rz_share'), 3),
                    gp_c=int(sd('gp_c')), td_c=int(sd('td_c')), tdg_c=int(sd('tdg_c')), tf_c=int(sd('tf_c')), gf_c=int(sd('gf_c')),
                    home_gp=int(sd('home_gp')), home_tdg=int(sd('home_tdg')), away_gp=int(sd('away_gp')), away_tdg=int(sd('away_tdg')),
                    last5=(s['last5'] if s is not None and isinstance(s['last5'], str) else '')))
            plist.sort(key=lambda z: -z['rate'])
            cd = cards.loc[team] if team in cards.index else None
            card = None if cd is None else {k: (v.item() if hasattr(v, 'item') else v) for k, v in cd.items()}
            teams.append(dict(team=team, opp=opp, home=is_home, p_first=pt, dst_share=dst_share,
                              imp=float(g.home_imp if is_home else g.away_imp) if not pd.isna(g.total_line) else None,
                              card=card, recent=recent_first(tl, logs, team, key), players=plist))
        actual = None
        if g.game_id in first.index:
            fr = first.loc[g.game_id]
            actual = dict(team=fr.td_team, name=(fr.td_player_name if fr.off else 'DEF/ST'), id=fr.td_player_id if fr.off else None)
        out_games.append(dict(id=g.game_id, day=g.gameday, time=g.gametime, weekday=g.weekday,
                              spread=float(g.spread_line) if not pd.isna(g.spread_line) else None,
                              total=float(g.total_line) if not pd.isna(g.total_line) else None,
                              p_notd=p_notd, final=None if pd.isna(g.home_score) else [int(g.away_score), int(g.home_score)],
                              actual=actual, teams=teams))
    return dict(week=week, injury_note=inj_note, games=out_games)


def main():
    d = prep()
    weeks = [int(w) for w in sys.argv[1:]] or [8, 9]
    data = dict(season=SEASON, built=dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%d %H:%M UTC'),
                params=PP, other_mass=OTHER_MASS, redist=REDIST_SAME_POS, inj_mult=INJ_MULT,
                backtest=P['backtest'], team_coef=P['team_coef'], team_coef_full=P.get('team_coef_full'),
                weeks=[build_week(d, w) for w in weeks])
    json.dump(data, open('ftd_data.json', 'w'), separators=(',', ':'), default=lambda o: o.item() if hasattr(o, 'item') else str(o))
    tpl = open('template.html').read()
    blob = json.dumps(data, separators=(',', ':'), default=lambda o: o.item() if hasattr(o, 'item') else str(o)).replace('</', '<\\/')
    open('index.html', 'w').write(tpl.replace('/*DATA*/null', blob))
    print('wrote ftd_data.json', sum(len(w['games']) for w in data['weeks']), 'games')


if __name__ == '__main__':
    main()
