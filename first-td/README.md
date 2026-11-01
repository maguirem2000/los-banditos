# First TD Board

Standalone first-touchdown-scorer simulator (first TD of the game). Open `index.html`: it is self-contained, with the data embedded.

## Weekly update

```bash
cd first-td
pip install pandas pyarrow scikit-learn
./refresh.sh 9 10              # pull nflverse data, price weeks 9 and 10
./refresh.sh --retune 9 10     # also re-fit the team model and player params (~7 min)
```

Run it after the Friday injury report for final prices. A week whose injury report isn't out yet uses roster moves (IR and inactive) only.

## Model

`P(player) = P(game has a TD) × P(team scores first) × P(offense, not D/ST) × P(player | team's first offensive TD)`

| Step | Inputs | Notes |
|---|---|---|
| Team scores first | Vegas spread/total → implied points, home | Logistic, fit on 2018–24. Team first-TD rate, opening-drive TD rate and Q1 scoring were tested; they didn't beat the line out of sample. |
| No TD | Game total | ~0.6% of games |
| D/ST | League rate (~5.4% of first TDs) × team return-TD rate × opponent giveaways | Shrunk toward league |
| Player share | xTD from every carry/target by yard line, blended with actual TDs, recency-weighted, depth-chart prior, early-drive (scripted) usage factor | Opponent-vs-position and home/away factors are available as UI knobs; the backtest gave them weight 0 |
| Injuries | Official report: Out/IR removed, Doubtful 15%, Questionable 88% | 65% of a removed player's share goes to same-position teammates |

Backtest (out of sample): the team model picks the first-scoring team 60% of the time over 377 games in 2025–26 (log-loss 0.667 vs 0.693 for a coin flip). The player model's log-loss is 2.21, vs 2.35 for raw TD counts, over 2026 weeks 1–7.

Files: `model.py` (features), `backtest.py` (fit and tune → `params.json`), `build.py` (slate → `ftd_data.json` + `index.html`), `template.html` (UI).
