"""Fit team model + tune player-share params with walk-forward backtest. Writes params.json."""
import json, itertools, pickle, os
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from model import *

CACHE = f"{DATA}/cache.pkl"


def prep():
    if os.path.exists(CACHE):
        return pickle.load(open(CACHE, 'rb'))
    pbp = load_pbp()
    games = load_games()
    tl, first = game_facts(pbp)
    xtab, bins = build_xtd_table(pbp[pbp.season <= 2025])
    logs = player_game_logs(pbp, first, xtab, bins)
    out = dict(games=games, tl=tl, first=first, xtab=xtab, bins=bins, logs=logs)
    pickle.dump(out, open(CACHE, 'wb'))
    return out


def roster_for(season, week):
    r = pd.read_parquet(f"{DATA}/roster_weekly_{season}.parquet")
    r = r[(r.week == week) & r.position.isin(POS_GROUP)]
    r = r.assign(pos=r.position.map(POS_GROUP), name=r.full_name)[['team', 'gsis_id', 'pos', 'name', 'status']]
    inj = pd.read_parquet(f"{DATA}/injuries_{season}.parquet")
    inj = inj[(inj.week == week)][['gsis_id', 'report_status']].drop_duplicates('gsis_id')
    r = r.merge(inj, on='gsis_id', how='left')
    return r


def rank_depth(res):
    res = res.sort_values('wx', ascending=False)
    res['depth_rank'] = res.groupby(['team', 'pos']).cumcount() + 1
    return res


def eval_players(d, params, keys, verbose=False):
    logs, first, games = d['logs'], d['first'], d['games']
    roster_pos_all = None
    ll, ll_base, n, hits = 0, 0, 0, []
    for key in keys:
        s, w = key // 100, key % 100
        ro = roster_for(s, w)
        ro = ro[ro.status.isin(['ACT', 'RES', 'INA'])]
        rp = ro[['gsis_id', 'pos']].rename(columns={'gsis_id': 'pid'}).drop_duplicates('pid')
        oppf, _, _ = opp_position_defense(logs, rp, key)
        # depth from usage (no historical depth charts)
        pre = player_table(logs, key, ro, pd.DataFrame(columns=['team', 'gsis_id', 'depth_rank']), None, params)
        dep = rank_depth(pre)[['team', 'gsis_id', 'depth_rank']]
        res = player_table(logs, key, ro, dep, None, params)
        gg = games[(games.season == s) & (games.week == w)]
        for _, g in gg.iterrows():
            if g.game_id not in first.index or first.loc[g.game_id].off != 1:
                continue
            f = first.loc[g.game_id]
            team = f.td_team
            opp = g.away_team if team == g.home_team else g.home_team
            home = team == g.home_team
            p = res[res.team == team].copy()
            if p.empty:
                continue
            mult = p.report_status.map(INJ_MULT).fillna(1.0)
            mult = np.where(p.status == 'ACT', mult, 0.0)
            of = np.array([oppf.loc[opp, pos] if opp in oppf.index and pos in oppf.columns else 1 for pos in p.pos])
            hf = p.home_f if home else p.away_f
            p['w0'] = p.rate * p.early_f * of ** params['opp_beta'] * hf
            p['w'] = p.w0 * mult
            sh = team_shares(p)
            # baseline: raw decayed actual TD rate, no adjustments
            b = (p.wt + 0.05) * mult
            bsh = b / b.sum() * (1 - OTHER_MASS)
            idx = p.index[p.gsis_id == f.td_player_id]
            pr = sh.loc[idx].sum() if len(idx) else OTHER_MASS
            pb = bsh.loc[idx].sum() if len(idx) else OTHER_MASS
            ll += -np.log(max(pr, 1e-4)); ll_base += -np.log(max(pb, 1e-4)); n += 1
            hits.append((pr, 1))
    return ll / n, ll_base / n, n


def main():
    d = prep()
    tl, games, first = d['tl'], d['games'], d['first']
    # ---------------- team model
    keys_fit = [s * 100 + w for s in range(2018, 2025) for w in range(1, 19)]
    keys_test = [s * 100 + w for s in (2025,) for w in range(1, 19)] + [202600 + w for w in range(1, 8)]
    X = team_design(tl, games, first, keys_fit + keys_test)
    fit = X[X.key.isin(keys_fit) & X.y.notna()]
    test = X[X.key.isin(keys_test) & X.y.notna()]
    lr = LogisticRegression(C=1.0).fit(fit[TEAM_FEATS], fit.y.astype(int))
    pt = lr.predict_proba(test[TEAM_FEATS])[:, 1]
    yt = test.y.astype(int).values
    ll = -np.mean(yt * np.log(pt) + (1 - yt) * np.log(1 - pt))
    ll0 = -np.log(.5)
    lr_v = LogisticRegression().fit(fit[['imp_diff', 'home']], fit.y.astype(int))
    pv = lr_v.predict_proba(test[['imp_diff', 'home']])[:, 1]
    llv = -np.mean(yt * np.log(pv) + (1 - yt) * np.log(1 - pv))
    acc = np.mean((pt > .5) == yt)
    print(f"team model test log-loss {ll:.4f} (coin {ll0:.4f}, vegas-only {llv:.4f}) acc {acc:.3f} n={len(test)}")
    print(dict(zip(TEAM_FEATS, lr.coef_[0].round(3))), lr.intercept_)
    # calibration buckets
    cal = pd.DataFrame(dict(p=pt, y=yt)).assign(b=lambda x: pd.cut(x.p, [0, .4, .45, .5, .55, .6, 1]))
    cal_tab = cal.groupby('b', observed=True).agg(pred=('p', 'mean'), actual=('y', 'mean'), n=('y', 'size'))
    print(cal_tab)
    # no-TD model on total
    Xa = X[X.notd.notna()]
    nt = LogisticRegression().fit(Xa[['total']], Xa.notd.astype(int))
    print('no-TD rate', Xa.notd.mean(), 'coef', nt.coef_, nt.intercept_)

    # ---------------- player share model tuning
    tune_keys = [202400 + w for w in range(2, 19)] + [202500 + w for w in range(1, 19)]
    hold_keys = [202600 + w for w in range(1, 8)]
    base = dict(hl=8, actual_wt=0.35, prior_games=3, early_beta=0.5, ha_beta=0.5, opp_beta=0.5)
    grid = dict(hl=[5, 6, 10], actual_wt=[0.2, 0.35, 0.5], early_beta=[0, 0.15, 0.3, 0.5],
                opp_beta=[0, 0.15, 0.3, 0.5], ha_beta=[0, 0.15, 0.3, 0.5], prior_games=[3, 4, 6])
    best = dict(base)
    best_ll, _, _ = eval_players(d, best, tune_keys)
    print('player base', best_ll)
    for _ in range(2):  # coordinate descent
        for k, vals in grid.items():
            for v in vals:
                cand = dict(best, **{k: v})
                l, _, _ = eval_players(d, cand, tune_keys)
                if l < best_ll - 1e-4:
                    best_ll, best = l, cand
            print(k, best[k], round(best_ll, 4))
    lh, lb, nh = eval_players(d, best, hold_keys)
    print(f"player holdout log-loss {lh:.4f} vs raw-TD baseline {lb:.4f} n={nh}")
    if llv < ll:  # simpler Vegas+home model generalises better -> use it
        chosen, cfeats = lr_v, ['imp_diff', 'home']
    else:
        chosen, cfeats = lr, TEAM_FEATS
    print('chosen team feats', cfeats, chosen.coef_, chosen.intercept_)
    out = dict(team_coef=dict(zip(cfeats, chosen.coef_[0].tolist())), team_int=float(chosen.intercept_[0]),
               team_coef_full=dict(zip(TEAM_FEATS, lr.coef_[0].tolist())),
               notd_coef=float(nt.coef_[0][0]), notd_int=float(nt.intercept_[0]), player=best,
               backtest=dict(team_ll=ll, team_ll_coin=ll0, team_ll_vegas=llv, team_acc=float(acc), team_n=len(test),
                             player_ll=lh, player_ll_base=lb, player_n=nh,
                             player_ll_uniform=None,
                             calibration=[dict(pred=float(r.pred), actual=float(r.actual), n=int(r.n)) for r in cal_tab.itertuples()]))
    json.dump(out, open('params.json', 'w'), indent=1)


if __name__ == '__main__':
    main()
