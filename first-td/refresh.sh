#!/usr/bin/env bash
# Weekly refresh: pull latest nflverse data, rebuild the first-TD board.
# Usage: ./refresh.sh [week ...]   (default: weeks 8 9 — pass the current and next week)
#        ./refresh.sh --retune 10 11   (also re-fit team model + player params, ~7 min)
set -euo pipefail
cd "$(dirname "$0")"
D="${FTD_DATA:-.data}"; mkdir -p "$D"
S=2026; R=https://github.com/nflverse/nflverse-data/releases/download
get(){ curl -fsSL -o "$D/$2" "$R/$1"; }
for y in $(seq 2018 $S); do [ -f "$D/pbp_$y.parquet" ] && [ $y -lt $S ] || get pbp/play_by_play_$y.parquet pbp_$y.parquet; done
for y in 2024 2025 $S; do get injuries/injuries_$y.parquet injuries_$y.parquet; get weekly_rosters/roster_weekly_$y.parquet roster_weekly_$y.parquet; done
get depth_charts/depth_charts_$S.parquet depth_$S.parquet
curl -fsSL -o "$D/games.csv" https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv
rm -f "$D/cache.pkl"
if [ "${1:-}" = "--retune" ]; then shift; python3 backtest.py; fi
python3 build.py "$@"
