/* Los Banditos league hub */
(function () {
  const D = window.LEAGUE_DATA;
  const E = window.LEAGUE_EXTRAS || {};
  const $ = (sel, el) => (el || document).querySelector(sel);
  const pname = pid => (E.playerNames && E.playerNames[pid]) ? E.playerNames[pid][0] : `#${pid}`;
  const ppos = pid => (E.playerNames && E.playerNames[pid]) ? E.playerNames[pid][1] : "";
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmt = (n, d = 2) => n == null ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = n => (n * 100).toFixed(1) + "%";

  /* fixed chart palette by roster seat (CVD-validated order, dark mode) */
  const SLOT_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
  const seatOf = {}; // uid -> roster seat (stable across seasons in this league)
  Object.values(D.seasonsData).forEach(sd => sd.standings.forEach(st => { seatOf[st.uid] = st.rid; }));
  const colorOf = uid => SLOT_COLORS[(seatOf[uid] || 1) - 1];

  const M = uid => D.managers[uid] || { name: "?", teamNames: {} };
  const nameOf = uid => M(uid).name;
  const teamOf = (uid, season) => M(uid).teamNames[season] || nameOf(uid);

  function avatarHtml(uid, size) {
    const m = M(uid);
    const s = size || 24;
    if (m.avatar) return `<img class="ava" style="width:${s}px;height:${s}px" src="${esc(m.avatar)}" alt="">`;
    const init = m.name.slice(0, 2).toUpperCase();
    return `<span class="ava" style="width:${s}px;height:${s}px">${esc(init)}</span>`;
  }
  function mgrChip(uid, opts) {
    const o = opts || {};
    const sub = o.sub ? ` <small>${esc(o.sub)}</small>` : "";
    return `<span class="mgr" data-mgr="${esc(uid)}">${avatarHtml(uid, o.size)}<span>${esc(o.label || nameOf(uid))}${sub}</span></span>`;
  }
  const typeLabel = t => ({
    regular: "", playoff: "Playoff", championship: "🏆 Championship", sacko: "💩 Shitter Bowl",
    "place-3": "3rd-place game", "place-5": "5th-place game", losers: "Consolation",
  }[t] ?? t);

  /* ---------- all games flattened (for game logs) ---------- */
  const ALL_GAMES = [];
  D.seasons.forEach(s => {
    const sd = D.seasonsData[s];
    (sd.regularGames || []).concat(sd.playoffGames || []).forEach(g => ALL_GAMES.push(g));
  });

  /* ---------- live current-season state ---------- */
  const LIVE = { loaded: false, failed: false, week: null, rosters: null, users: null, matchups: {}, seasonActive: false };
  async function loadLive() {
    const lid = D.currentLeague.leagueId;
    const j = url => fetch(url).then(r => r.json());
    try {
      const [state, rosters, users] = await Promise.all([
        j("https://api.sleeper.app/v1/state/nfl"),
        j(`https://api.sleeper.app/v1/league/${lid}/rosters`),
        j(`https://api.sleeper.app/v1/league/${lid}/users`),
      ]);
      const wks = [];
      for (let w = 1; w <= 17; w++) wks.push(j(`https://api.sleeper.app/v1/league/${lid}/matchups/${w}`));
      const mats = await Promise.all(wks);
      mats.forEach((m, i) => { LIVE.matchups[i + 1] = m || []; });
      LIVE.rosters = rosters; LIVE.users = users;
      LIVE.seasonActive = state.season === D.currentSeason && state.season_type === "regular";
      LIVE.week = LIVE.seasonActive ? Math.max(1, Math.min(17, state.week || 1)) : 1;
      LIVE.loaded = true;
      if (GD_SIM) { LIVE.seasonActive = true; simScores(LIVE.week); }
      render(); // refresh whatever view is open with live numbers
      maybeTakePrompt();
      ensureWyrPairs(); // all three loaders race; whichever finishes last seeds the week's poll
    } catch (e) {
      LIVE.failed = true;
      console.warn("Live Sleeper fetch failed; using baked data", e);
    }
  }

  /* live-aware helpers for the current season */
  function currentStandings() {
    if (LIVE.loaded) {
      const umap = {}; LIVE.users.forEach(u => umap[u.user_id] = u);
      return LIVE.rosters.map(r => ({
        uid: r.owner_id, rid: r.roster_id,
        wins: r.settings.wins || 0, losses: r.settings.losses || 0, ties: r.settings.ties || 0,
        pf: (r.settings.fpts || 0) + (r.settings.fpts_decimal || 0) / 100,
        pa: (r.settings.fpts_against || 0) + (r.settings.fpts_against_decimal || 0) / 100,
        division: r.settings.division,
        team: (umap[r.owner_id]?.metadata || {}).team_name || umap[r.owner_id]?.display_name,
      })).sort((a, b) => b.wins - a.wins || b.pf - a.pf);
    }
    return D.seasonsData[D.currentSeason].standings.map(st => ({ ...st, team: teamOf(st.uid, D.currentSeason) }));
  }
  function weekMatchups(season, week) {
    if (season === D.currentSeason && LIVE.loaded) {
      const rows = LIVE.matchups[week] || [];
      const r2u = {}; LIVE.rosters.forEach(r => r2u[r.roster_id] = r.owner_id);
      const by = {};
      rows.forEach(r => { if (r.matchup_id != null) (by[r.matchup_id] = by[r.matchup_id] || []).push(r); });
      return Object.values(by).filter(p => p.length === 2).map(([a, b]) => ({
        season, week, type: week >= D.currentLeague.playoffWeekStart ? "playoff" : "regular",
        a: { uid: r2u[a.roster_id], pts: a.points || 0 },
        b: { uid: r2u[b.roster_id], pts: b.points || 0 },
        played: (a.points || 0) > 0 || (b.points || 0) > 0,
      }));
    }
    const sd = D.seasonsData[season];
    const reg = (sd.regularGames || []).filter(g => g.week === week).map(g => ({ ...g, played: true }));
    const po = (sd.playoffGames || []).filter(g => g.week === week).map(g => ({ ...g, played: true }));
    return reg.concat(po);
  }

  /* ================= views ================= */
  const VIEWS = {
    home: { label: "Home", render: vHome },
    standings: { label: "Standings", render: vStandings },
    schedule: { label: "Schedule", render: vSchedule },
    h2h: { label: "Head-to-Head", render: vH2H },
    records: { label: "Record Book", render: vRecords },
    power: { label: "Power Rankings", render: vPower },
    picks: { label: "Pick'em & Poll", render: vPicks },
    preview: { label: "Season Preview", render: vPreview },
    takes: { label: "Hot Takes", render: vTakes },
    franchises: { label: "Franchises", render: vFranchise },
    elo: { label: "Elo Ratings", render: vElo },
    players: { label: "Passports", render: vPlayers },
    bench: { label: "Boneheads", render: vBench },
    trades: { label: "Trades", render: vTrades },
    tradefinder: { label: "Trade Finder", render: vTradeFinder },
    awards: { label: "Awards", render: vAwards },
    trophies: { label: "Trophy Room", render: vTrophies },
    shame: { label: "Shame Wall", render: vShame },
    drafts: { label: "Drafts", render: vDrafts },
  };
  /* nav groups: 6 top-level sections, sub-pages as pills */
  const GROUPS = [
    { label: "Home", views: { home: "Home" } },
    { label: "Season", views: { standings: "Standings", schedule: "Schedule", power: "Power & Odds", picks: "Pick'em & Poll", takes: "Hot Takes", preview: "Season Preview" } },
    { label: "History", views: { records: "Record Book", h2h: "Head-to-Head", elo: "Elo Ratings", awards: "Awards", players: "Passports" } },
    { label: "Teams", views: { franchises: "Franchise Pages", bench: "Boneheads" } },
    { label: "Moves", views: { trades: "Trades & Waivers", tradefinder: "Trade Finder", drafts: "Drafts" } },
    { label: "Trophies", views: { trophies: "Trophy Room", shame: "Shame Wall" } },
  ];
  const groupOf = view => GROUPS.find(g => view in g.views) || GROUPS[0];

  const state = { view: "home", season: D.currentSeason, week: 1, draftSeason: D.completeSeasons[D.completeSeasons.length - 1], powerSeason: null, weekTouched: false };

  /* ---------- vegas odds ---------- */
  let _profiles = null;
  function scoringProfile(uid) {
    if (!_profiles) {
      _profiles = {};
      const byUid = {};
      D.completeSeasons.forEach(s => {
        D.seasonsData[s].regularGames.forEach(g => {
          [["a"], ["b"]].forEach(([side]) => {
            const t = g[side];
            (byUid[t.uid] = byUid[t.uid] || []).push({ pts: t.pts, season: s });
          });
        });
      });
      Object.entries(byUid).forEach(([uid2, rows]) => {
        const last = D.completeSeasons[D.completeSeasons.length - 1];
        const all = rows.map(r => r.pts);
        const recent = rows.filter(r => r.season === last).map(r => r.pts);
        const mean = arr => arr.reduce((s, x) => s + x, 0) / arr.length;
        const m = recent.length >= 6 ? 0.65 * mean(recent) + 0.35 * mean(all) : mean(all);
        const mu = mean(all);
        const sd = Math.sqrt(all.reduce((s, x) => s + (x - mu) ** 2, 0) / Math.max(1, all.length - 1));
        _profiles[uid2] = { mean: m, sd: Math.max(16, sd) };
      });
    }
    return _profiles[uid] || { mean: 130, sd: 25 };
  }
  const normCdf = z => 0.5 * (1 + Math.tanh(Math.sqrt(Math.PI / 8) * z * (1 + 0.044715 * z * z / 3)));
  function toML(p) {
    const q = Math.min(0.97, Math.max(0.03, p + 0.02)); // a little house juice
    const ml = q >= 0.5 ? -Math.round(100 * q / (1 - q) / 5) * 5 : Math.round(100 * (1 - q) / q / 5) * 5;
    return ml > 0 ? "+" + ml : String(ml);
  }
  function matchupOdds(g, projWeek) {
    // current-season blend: live scores shrunk toward prior, projections override when present
    const est = uid => {
      const prof = scoringProfile(uid);
      let mean = prof.mean, n = 0;
      if (LIVE.loaded) {
        const scores = [];
        for (let w = 1; w < D.currentLeague.playoffWeekStart; w++) {
          weekMatchups(D.currentSeason, w).forEach(x => {
            if (!x.played) return;
            if (x.a.uid === uid) scores.push(x.a.pts);
            if (x.b.uid === uid) scores.push(x.b.pts);
          });
        }
        n = scores.length;
        if (n) mean = (scores.reduce((s, x) => s + x, 0) + prof.mean * 5) / (n + 5);
      }
      const proj = projWeek ? projectedPts(projWeek, uid) : null;
      if (proj != null) mean = 0.6 * proj + 0.4 * mean;
      return { mean, sd: prof.sd };
    };
    const A = est(g.a.uid), B = est(g.b.uid);
    const pA = normCdf((A.mean - B.mean) / Math.sqrt(A.sd ** 2 + B.sd ** 2));
    const fav = pA >= 0.5 ? g.a.uid : g.b.uid;
    const spread = Math.round(Math.abs(A.mean - B.mean) * 2) / 2;
    return {
      fav, pA,
      spread: Math.max(0.5, spread),
      total: Math.round((A.mean + B.mean) * 2) / 2,
      mlA: toML(pA), mlB: toML(1 - pA),
    };
  }
  function oddsLine(g, projWeek) {
    if (g.played || g.season !== D.currentSeason) return "";
    const o = matchupOdds(g, projWeek);
    return `<div class="grudge odds">🎰 ${esc(nameOf(o.fav))} −${o.spread} · ML ${o.fav === g.a.uid ? o.mlA : o.mlB} / ${o.fav === g.a.uid ? o.mlB : o.mlA} · O/U ${fmt(o.total, 1)}</div>`;
  }

  /* ---------- gameday live mode ---------- */
  const GD_SIM = /[?&]gdsim/.test(location.search); // dev preview: fabricates in-progress scores client-side
  const GD = { last: null, prev: {} };

  function gamedayActive() {
    if (GD_SIM) return true;
    if (!LIVE.loaded || !LIVE.seasonActive) return false;
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", hour12: false }).formatToParts(new Date());
    const wd = parts.find(p => p.type === "weekday").value, hr = +parts.find(p => p.type === "hour").value;
    return (wd === "Thu" && hr >= 19) || (wd === "Sun" && hr >= 12) || (wd === "Mon" && hr >= 19) || (wd === "Sat" && hr >= 12);
  }

  function simScores(wk) {
    (LIVE.matchups[wk] || []).forEach(row => {
      const pp = {}; let tot = 0;
      (row.starters || []).forEach(pid => {
        const base = (projCache[wk] && projCache[wk][pid]) || 10;
        const v = Math.round(base * Math.random() * (0.4 + Math.random() * 1.4) * 10) / 10;
        pp[pid] = v; tot += v;
      });
      row.players_points = pp; row.points = Math.round(tot * 100) / 100;
    });
  }

  let gdRefreshing = false;
  async function refreshLive() {
    if (gdRefreshing || !LIVE.loaded || !gamedayActive() || document.hidden) return;
    gdRefreshing = true;
    try {
      const wk = LIVE.week || 1;
      const rows = await fetch(`https://api.sleeper.app/v1/league/${D.currentLeague.leagueId}/matchups/${wk}`).then(r => r.json());
      LIVE.matchups[wk] = rows || [];
      if (GD_SIM) simScores(wk);
      GD.last = new Date();
      if (["home", "schedule", "picks"].includes(state.view)) render();
    } catch (e) { /* transient network blip — next tick retries */ }
    gdRefreshing = false;
  }
  setInterval(refreshLive, 60000);

  /* banked starter points + remaining projection for one team's live week */
  function gdEst(uid, wk) {
    const map = projCache[wk];
    if (!map || !LIVE.loaded) return null;
    const rid = LIVE.rosters.find(r => r.owner_id === uid)?.roster_id;
    const row = (LIVE.matchups[wk] || []).find(r => r.roster_id === rid);
    if (!row || !(row.starters || []).length) return null;
    let act = 0, rem = 0, projTot = 0;
    row.starters.forEach(pid => {
      const a = (row.players_points || {})[pid] || 0, pr = map[pid] || 0;
      act += a; projTot += pr; rem += Math.max(0, pr - a);
    });
    return { act, rem, projTot, exp: act + rem };
  }

  /* live win probability: uncertainty shrinks as games burn down */
  function liveWinProb(g) {
    if (!LIVE.loaded || g.season !== D.currentSeason || g.week !== LIVE.week) return null;
    if (!gamedayActive() && !g.played) return null;
    if (!projCache[g.week]) { fetchProjections(g.week); return null; }
    const est = uid => {
      const e = gdEst(uid, g.week);
      if (!e) return null;
      const prof = scoringProfile(uid);
      return { exp: e.exp, sd: Math.max(4, prof.sd * (e.projTot > 0 ? Math.sqrt(e.rem / e.projTot) : 1)) };
    };
    const A = est(g.a.uid), B = est(g.b.uid);
    if (!A || !B) return null;
    return { pA: normCdf((A.exp - B.exp) / Math.sqrt(A.sd * A.sd + B.sd * B.sd)), expA: A.exp, expB: B.exp };
  }

  /* league records in danger right now, shown only while games are live */
  function liveRecordsWatch() {
    if (!LIVE.loaded || !gamedayActive()) return "";
    const wk = LIVE.week || 1;
    const games = weekMatchups(D.currentSeason, wk);
    if (!games.some(g => g.played) || !projCache[wk]) return "";
    const R = D.records, items = [];
    const hi = R.highScores[0], lo = R.lowScores[0];
    const ests = {};
    games.forEach(g => [g.a.uid, g.b.uid].forEach(u => { const e = gdEst(u, wk); if (e) ests[u] = e; }));
    Object.entries(ests).forEach(([uid, e]) => {
      if (e.exp >= hi.pts - 12) items.push({ icon: "🚨", text: `${nameOf(uid)} projects to ${fmt(e.exp, 1)} — the all-time record is ${fmt(hi.pts)} (${nameOf(hi.uid)}, ${hi.season})` });
      if (e.act > 20 && e.exp <= lo.pts + 12) items.push({ icon: "🧻", text: `${nameOf(uid)} is pacing toward ${fmt(e.exp, 1)} — the all-time floor is ${fmt(lo.pts)} (${nameOf(lo.uid)}, ${lo.season})` });
    });
    games.forEach(g => {
      const ea = ests[g.a.uid], eb = ests[g.b.uid];
      if (!ea || !eb) return;
      const margin = Math.abs(ea.exp - eb.exp), total = ea.exp + eb.exp;
      const bw = R.blowouts[0], sh = R.shootouts[0];
      if (margin >= bw.margin - 15) items.push({ icon: "💥", text: `${nameOf(ea.exp >= eb.exp ? g.a.uid : g.b.uid)} is projected to win by ${fmt(margin, 1)} — the biggest beatdown ever is ${fmt(bw.margin)}` });
      if (total >= sh.hi.pts + sh.lo.pts - 20) items.push({ icon: "🎆", text: `${nameOf(g.a.uid)} vs ${nameOf(g.b.uid)} projects to ${fmt(total, 1)} combined — the shootout record is ${fmt(sh.hi.pts + sh.lo.pts)}` });
    });
    if (E.playerRecords && E.playerRecords.topStarters.length) {
      const rec = E.playerRecords.topStarters[0];
      const r2u = {}; LIVE.rosters.forEach(r => r2u[r.roster_id] = r.owner_id);
      (LIVE.matchups[wk] || []).forEach(row => {
        const starters = new Set(row.starters || []);
        Object.entries(row.players_points || {}).forEach(([pid, pts]) => {
          if (starters.has(pid) && pts >= rec.pts - 12) items.push({ icon: "⭐", text: `${pname(pid)} has ${fmt(pts)} for ${nameOf(r2u[row.roster_id])} — the best game ever started is ${fmt(rec.pts)} (${pname(rec.pid)})` });
        });
      });
    }
    if (!items.length) return "";
    return `<div class="card"><h2>Live Records Watch <span class="pill live">LIVE</span> <span class="tag">history is in danger right now</span></h2>
      <ul class="watch">${items.slice(0, 6).map(i => `<li><span class="wi">${i.icon}</span> ${esc(i.text)}</li>`).join("")}</ul></div>`;
  }

  function wpLine(g) {
    const wp = liveWinProb(g);
    if (!wp) return "";
    const k = [g.a.uid, g.b.uid].sort().join("|");
    const prev = GD.prev[k];
    let swing = "";
    if (prev != null && Math.abs(wp.pA - prev) >= 0.03) {
      const towardA = wp.pA > prev;
      const who = towardA ? g.a.uid : g.b.uid;
      swing = ` · <b style="color:${colorOf(who)}">${esc(nameOf(who))} ▲${Math.round(Math.abs(wp.pA - prev) * 100)}</b>`;
    }
    if (prev == null || Math.abs(wp.pA - prev) >= 0.005) GD.prev[k] = wp.pA;
    return `<div class="wp"><div class="wp-bar"><div class="wp-a" style="width:${(wp.pA * 100).toFixed(1)}%;background:${colorOf(g.a.uid)}"></div><div class="wp-b" style="background:${colorOf(g.b.uid)}"></div></div>
      <div class="wp-lbl">${esc(nameOf(g.a.uid))} <b>${Math.round(wp.pA * 100)}%</b> · <b>${Math.round((1 - wp.pA) * 100)}%</b> ${esc(nameOf(g.b.uid))}${swing} <small>proj final ${fmt(wp.expA, 0)}–${fmt(wp.expB, 0)}</small></div></div>`;
  }

  function gameRow(g, opts) {
    const o = opts || {};
    const played = g.played !== false;
    let aWin, bWin;
    if (g.type !== "regular" && g.winner) { aWin = g.winner === g.a.uid; bWin = g.winner === g.b.uid; }
    else { aWin = played && g.a.pts > g.b.pts; bWin = played && g.b.pts > g.a.pts; }
    const side = (t, win, lose) => {
      let ptsHtml = played ? fmt(t.pts) : "—";
      if (!played && o.proj) {
        const pp = projectedPts(o.proj, t.uid);
        if (pp != null) ptsHtml = `<span style="color:var(--muted);font-weight:400;font-size:13px">proj ${fmt(pp, 1)}</span>`;
      }
      return `
      <div class="row ${win ? "winner" : ""} ${lose ? "loser" : ""}">
        ${mgrChip(t.uid, { label: o.teamNames ? teamOf(t.uid, g.season) : nameOf(t.uid) })}
        <span class="pts">${ptsHtml}</span>
      </div>`;
    };
    const lbl = typeLabel(g.type);
    let grudge = "";
    if (!played) grudge = oddsLine(g, o.proj) + grudgeLine(g.a.uid, g.b.uid);
    return `<div class="matchup">
      ${side(g.a, aWin, played && bWin)}
      ${side(g.b, bWin, played && aWin)}
      <div class="meta">${esc(g.season)} · Week ${g.week}${lbl ? " · " + lbl : ""}${played ? "" : " · upcoming"}</div>
      ${wpLine(g)}
      ${grudge}
    </div>`;
  }

  function grudgeLine(a, b) {
    const r = (D.h2h[a] || {})[b];
    if (!r) return `<div class="grudge">First-ever meeting 🍿</div>`;
    const aw = r.w + r.pw, al = r.l + r.pl;
    const series = aw > al ? `${nameOf(a)} leads ${aw}-${al}` : al > aw ? `${nameOf(b)} leads ${al}-${aw}` : `series tied ${aw}-${al}`;
    const past = ALL_GAMES.filter(g => (g.a.uid === a && g.b.uid === b) || (g.a.uid === b && g.b.uid === a))
      .sort((x, y) => x.season.localeCompare(y.season) || x.week - y.week);
    let extra = "";
    if (past.length) {
      const lastG = past[past.length - 1];
      const me = lastG.a.uid === a ? lastG.a : lastG.b, them = lastG.a.uid === a ? lastG.b : lastG.a;
      const lastWin = lastG.type === "regular" ? me.pts > them.pts : lastG.winner === a;
      extra = ` · last: ${nameOf(lastWin ? a : b)} won ${fmt(Math.max(me.pts, them.pts))}–${fmt(Math.min(me.pts, them.pts))} (${lastG.season} wk ${lastG.week})`;
      let n = 0, who = null;
      for (let i = past.length - 1; i >= 0; i--) {
        const g2 = past[i];
        const w2 = g2.type === "regular" ? (g2.a.pts > g2.b.pts ? g2.a.uid : g2.b.uid) : g2.winner;
        if (who === null) { who = w2; n = 1; }
        else if (w2 === who) n++;
        else break;
      }
      if (n >= 2) extra += ` · ${nameOf(who)} has won ${n} straight`;
    }
    return `<div class="grudge">🥊 ${esc(series)}${esc(extra)}</div>${revengeLine(a, b)}`;
  }

  /* players facing a manager who used to roster them */
  function revengeLine(a, b) {
    if (!LIVE.loaded || !E.formerTeams) return "";
    const bits = [];
    for (const [me, them] of [[a, b], [b, a]]) {
      const roster = LIVE.rosters.find(r => r.owner_id === me);
      if (!roster) continue;
      const rid = roster.roster_id;
      const wk = LIVE.week || 1;
      const row = (LIVE.matchups[wk] || []).find(r => r.roster_id === rid);
      const pids = (row && row.players && row.players.length ? row.players : roster.players) || [];
      const revs = pids.filter(pid => (E.formerTeams[pid] || []).includes(them) && E.playerNames && E.playerNames[pid]);
      if (revs.length) bits.push(`${pname(revs[0])} faces his old ${esc(nameOf(them))} squad`);
      if (bits.length >= 2) break;
    }
    return bits.length ? `<div class="grudge revenge">🔥 Revenge: ${bits.join(" · ")}</div>` : "";
  }

  /* ---------- HOME ---------- */
  function vHome() {
    const c = D.career;
    const hi = D.records.highScores[0], lo = D.records.lowScores[0];
    const lastSeason = D.completeSeasons[D.completeSeasons.length - 1];
    const champUid = D.seasonsData[lastSeason].champion;
    const mostTitles = Object.entries(c).sort((a, b) => b[1].champs.length - a[1].champs.length)[0];
    const wk = LIVE.loaded ? LIVE.week : 1;
    const games = weekMatchups(D.currentSeason, wk);
    const anyPlayed = games.some(g => g.played);
    if (LIVE.loaded && (games.some(g => !g.played) || gamedayActive())) fetchProjections(wk);

    const careerRows = Object.keys(c)
      .sort((a, b) => (c[b].w / Math.max(1, c[b].w + c[b].l)) - (c[a].w / Math.max(1, c[a].w + c[a].l)))
      .map((uid, i) => {
        const x = c[uid]; const gp = x.w + x.l + x.t;
        return `<tr class="me-row"><td class="rank-cell">${i + 1}</td>
          <td>${mgrChip(uid)}</td>
          <td class="num">${x.w}-${x.l}${x.t ? "-" + x.t : ""}</td>
          <td class="num">${gp ? pct(x.w / gp) : "—"}</td>
          <td class="num">${fmt(x.pf, 1)}</td>
          <td class="num">${gp ? fmt(x.pf / gp) : "—"}</td>
          <td class="num">${x.champs.length ? "🏆".repeat(x.champs.length) : ""}${x.sackos.length ? "💩".repeat(x.sackos.length) : ""}</td></tr>`;
      }).join("");

    return `
      <div class="tiles">
        <div class="tile gold"><div class="k">Reigning Champion</div><div class="v">${esc(nameOf(champUid))}</div><div class="d">${esc(lastSeason)} · ${esc(teamOf(champUid, lastSeason))}</div></div>
        <div class="tile gold"><div class="k">Most Titles</div><div class="v">${mostTitles[1].champs.length}× ${esc(nameOf(mostTitles[0]))}</div><div class="d">${mostTitles[1].champs.join(", ")}</div></div>
        <div class="tile blue"><div class="k">Highest Score Ever</div><div class="v">${fmt(hi.pts)}</div><div class="d">${esc(nameOf(hi.uid))} · ${hi.season} wk ${hi.week}</div></div>
        <div class="tile red"><div class="k">Lowest Score Ever</div><div class="v">${fmt(lo.pts)}</div><div class="d">${esc(nameOf(lo.uid))} · ${lo.season} wk ${lo.week}</div></div>
      </div>

      ${recapOrCountdown()}

      <div class="card">
        <h2>Week ${wk} · ${esc(D.currentSeason)} ${LIVE.loaded ? '<span class="pill live">LIVE</span>' : ""}${gamedayActive() ? '<span class="pill champ">🔴 GAMEDAY</span>' : ""}<span class="tag">${gamedayActive()
          ? "auto-updating every 60s" + (GD.last ? " · updated " + GD.last.toLocaleTimeString() : "") + (GD_SIM ? " · ⚠️ SIMULATED DATA" : "")
          : anyPlayed ? "" : "season hasn’t kicked off — matchups set"}</span></h2>
        <div class="matchup-grid">${games.map(g => gameRow(g, { teamNames: true, proj: wk })).join("") || '<p class="note">No matchups posted yet.</p>'}</div>
      </div>

      ${liveRecordsWatch()}

      ${htHomeCard()}

      ${wyrCard()}

      ${(E.recordsWatch || []).length ? `<div class="card"><h2>Records Watch <span class="tag">storylines heading into ${esc(D.currentSeason)}</span></h2>
        <ul class="watch">${E.recordsWatch.map(w => `<li><span class="wi">${w.icon}</span> ${esc(w.text)}</li>`).join("")}</ul></div>` : ""}

      ${historyCard()}

      <div class="card">
        <h2>All-Time Standings <span class="tag">regular season, ${D.completeSeasons[0]}–${lastSeason}</span></h2>
        <div class="table-scroll"><table>
          <tr><th></th><th>Manager</th><th class="num">Record</th><th class="num">Win %</th><th class="num">PF</th><th class="num">PPG</th><th class="num">Hardware</th></tr>
          ${careerRows}
        </table></div>
      </div>`;
  }

  /* recap of the latest played week, or a kickoff countdown in the preseason */
  function recapOrCountdown() {
    // find latest played week in the current season (live data preferred)
    let lastWk = 0;
    for (let w = 17; w >= 1; w--) {
      if (weekMatchups(D.currentSeason, w).some(g => g.played)) { lastWk = w; break; }
    }
    if (!lastWk) {
      const ko = new Date(E.kickoff || "2026-09-09T20:20:00-04:00");
      const days = Math.max(0, Math.ceil((ko - Date.now()) / 86400000));
      const koLbl = ko.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      return `<div class="card countdown">
        <h2>Kickoff Countdown</h2>
        <div class="cd-num">${days}</div>
        <div class="cd-sub">days until the ${esc(D.currentSeason)} season opener (${esc(koLbl)}). Draft is done — rosters are locked and loaded.</div>
      </div>`;
    }
    const games = weekMatchups(D.currentSeason, lastWk).filter(g => g.played);
    if (!games.length) return "";
    const byMargin = games.slice().sort((a, b) => Math.abs(a.a.pts - a.b.pts) - Math.abs(b.a.pts - b.b.pts));
    const closest = byMargin[0], beatdown = byMargin[byMargin.length - 1];
    const topTeam = games.flatMap(g => [g.a, g.b]).sort((a, b) => b.pts - a.pts)[0];
    // player-level awards from live rows if available
    let pow = "", blunder = "";
    if (LIVE.loaded && LIVE.matchups[lastWk]) {
      const r2u = {}; LIVE.rosters.forEach(r => r2u[r.roster_id] = r.owner_id);
      let top = { pts: -1 }, bench = { pts: -1 };
      LIVE.matchups[lastWk].forEach(row => {
        const starters = new Set(row.starters || []);
        Object.entries(row.players_points || {}).forEach(([pid, pts]) => {
          const rec = { pid, pts: pts || 0, uid: r2u[row.roster_id] };
          if (starters.has(pid)) { if (rec.pts > top.pts) top = rec; }
          else if (rec.pts > bench.pts) bench = rec;
        });
      });
      if (top.pid) pow = `<li>⭐ <b>Player of the Week:</b> ${esc(pname(top.pid))} dropped <b>${fmt(top.pts)}</b> for ${esc(nameOf(top.uid))}</li>`;
      if (bench.pid && bench.pts >= 15) blunder = `<li>🤡 <b>Bench Blunder:</b> ${esc(nameOf(bench.uid))} left ${esc(pname(bench.pid))}'s <b>${fmt(bench.pts)}</b> on the bench</li>`;
    }
    const gname = g => `${nameOf(g.a.pts >= g.b.pts ? g.a.uid : g.b.uid)} over ${nameOf(g.a.pts >= g.b.pts ? g.b.uid : g.a.uid)} ${fmt(Math.max(g.a.pts, g.b.pts))}–${fmt(Math.min(g.a.pts, g.b.pts))}`;
    return `<div class="card">
      <h2>Week ${lastWk} Recap <span class="tag">auto-generated</span></h2>
      <ul class="watch">
        <li>🔥 <b>Top score:</b> ${esc(nameOf(topTeam.uid))} with <b>${fmt(topTeam.pts)}</b></li>
        <li>😅 <b>Game of the Week:</b> ${esc(gname(closest))} (margin ${fmt(Math.abs(closest.a.pts - closest.b.pts))})</li>
        <li>💥 <b>Beatdown:</b> ${esc(gname(beatdown))}</li>
        ${pow}${blunder}
      </ul></div>`;
  }

  /* one notable moment per past season from the current week number */
  function historyCard() {
    const wk = LIVE.loaded ? LIVE.week : 1;
    const R = D.records;
    const rankIn = (list, pred) => { const i = (list || []).findIndex(pred); return i < 0 ? null : i + 1; };
    const items = [];
    D.completeSeasons.slice().reverse().forEach(s => {
      const games = ALL_GAMES.filter(g => g.season === s && g.week === wk);
      if (!games.length) return;
      let best = null;
      games.forEach(g => {
        const hi = g.a.pts >= g.b.pts ? g.a : g.b, lo = g.a.pts >= g.b.pts ? g.b : g.a;
        const margin = hi.pts - lo.pts;
        const cand = [];
        if (g.type === "championship" && g.winner) {
          const loser = g.winner === g.a.uid ? g.b.uid : g.a.uid;
          cand.push({ pri: 0, icon: "🏆", text: `${nameOf(g.winner)} beat ${nameOf(loser)} ${fmt(Math.max(g.a.pts, g.b.pts))}–${fmt(Math.min(g.a.pts, g.b.pts))} for the title` });
        }
        if (g.type === "sacko" && g.winner) {
          const shitter = g.winner === g.a.uid ? g.b.uid : g.a.uid;
          cand.push({ pri: 1, icon: "💩", text: `${nameOf(shitter)} sealed the Shitter, falling to ${nameOf(g.winner)} in the Shitter Bowl` });
        }
        let rk = rankIn(R.highScores, x => x.uid === hi.uid && x.season === s && x.week === wk && Math.abs(x.pts - hi.pts) < 0.01);
        if (rk) cand.push({ pri: 2, icon: "🔥", text: `${nameOf(hi.uid)} hung ${fmt(hi.pts)} on ${nameOf(lo.uid)} — still the #${rk} score in league history` });
        rk = rankIn(R.lowScores, x => x.uid === lo.uid && x.season === s && x.week === wk && Math.abs(x.pts - lo.pts) < 0.01);
        if (rk) cand.push({ pri: 3, icon: "🥶", text: `${nameOf(lo.uid)} managed just ${fmt(lo.pts)} — the #${rk} lowest score ever` });
        rk = rankIn(R.blowouts, x => x.season === s && x.week === wk && Math.abs(x.margin - margin) < 0.01);
        if (rk) cand.push({ pri: 4, icon: "💥", text: `${nameOf(hi.uid)} blew out ${nameOf(lo.uid)} by ${fmt(margin)} — the #${rk} beatdown of all time` });
        rk = rankIn(R.nailbiters, x => x.season === s && x.week === wk && Math.abs(x.margin - margin) < 0.01);
        if (rk) cand.push({ pri: 5, icon: "😅", text: `${nameOf(hi.uid)} survived ${nameOf(lo.uid)} by ${fmt(margin)} — the #${rk} closest game ever` });
        cand.forEach(c => { if (!best || c.pri < best.pri) best = c; });
      });
      if (!best) {
        const top = games.flatMap(g => [g.a, g.b]).sort((a, b) => b.pts - a.pts)[0];
        best = { icon: "🏈", text: `${nameOf(top.uid)} led the week with ${fmt(top.pts)}` };
      }
      items.push(`<li><span class="wi">${best.icon}</span> <b>${s}:</b> ${esc(best.text)}</li>`);
    });
    if (!items.length) return "";
    return `<div class="card"><h2>This Week in League History <span class="tag">week ${wk}, through the years</span></h2>
      <ul class="watch">${items.join("")}</ul></div>`;
  }

  /* ---------- STANDINGS ---------- */
  function vStandings() {
    const season = state.season;
    const isCurrent = season === D.currentSeason;
    const sd = D.seasonsData[season];
    const rows = isCurrent ? currentStandings() : sd.standings.map(st => ({ ...st, team: teamOf(st.uid, season) }));
    const divs = sd.divisions || {};
    const hasDivs = rows.some(r => r.division);

    function divRec(uid) {
      const baked = ((E.divisions || {})[season] || {}).records;
      if (baked && baked[uid]) return `${baked[uid].divW}-${baked[uid].divL}`;
      if (isCurrent) {
        const divmap = {};
        rows.forEach(r => divmap[r.uid] = r.division);
        let w = 0, l = 0;
        for (let wk = 1; wk < (sd ? sd.playoffWeekStart : 15); wk++) {
          weekMatchups(season, wk).forEach(g => {
            if (!g.played) return;
            const me = g.a.uid === uid ? g.a : g.b.uid === uid ? g.b : null;
            if (!me) return;
            const them = g.a.uid === uid ? g.b : g.a;
            if (divmap[me.uid] && divmap[me.uid] === divmap[them.uid]) {
              if (me.pts > them.pts) w++; else if (me.pts < them.pts) l++;
            }
          });
        }
        return (w + l) ? `${w}-${l}` : "0-0";
      }
      return "—";
    }
    function tableFor(list, title) {
      const maxPF = Math.max(...list.map(r => r.pf), 1);
      return `<div class="card"><h2>${esc(title)}</h2>
        <div class="table-scroll"><table>
        <tr><th></th><th>Team</th><th class="num">W</th><th class="num">L</th><th class="num">Div</th><th class="num">PF</th><th class="num">PA</th><th style="min-width:150px">Points For</th><th class="num">Finish</th></tr>
        ${list.map((r, i) => `<tr class="me-row">
          <td class="rank-cell">${i + 1}</td>
          <td>${mgrChip(r.uid, { label: r.team, sub: nameOf(r.uid) })}</td>
          <td class="num">${r.wins}</td><td class="num">${r.losses}</td>
          <td class="num">${divRec(r.uid)}</td>
          <td class="num">${fmt(r.pf)}</td><td class="num">${fmt(r.pa)}</td>
          <td><div class="ibar"><div class="track"><div class="fill" style="width:${(r.pf / maxPF * 100).toFixed(1)}%;background:${colorOf(r.uid)}"></div></div></div></td>
          <td class="num">${r.place === 1 ? '<span class="pill champ">CHAMP</span>' : r.place === 8 ? '<span class="pill sacko">SHITTER</span>' : (r.place ? ordinal(r.place) : "—")}</td>
        </tr>`).join("")}
        </table></div></div>`;
    }

    let body;
    if (hasDivs) {
      const d1 = rows.filter(r => r.division === 1), d2 = rows.filter(r => r.division === 2);
      body = tableFor(d1, divs["1"] || "Division 1") + tableFor(d2, divs["2"] || "Division 2");
    } else {
      body = tableFor(rows, "League");
    }
    return seasonPicker() + body + whatIfCard(season) + luckCard(season);
  }

  function whatIfCard(season) {
    const w = (E.whatIf || {})[season];
    if (!w) return season === D.currentSeason
      ? "" : "";
    const cell = (a, b) => {
      const [wi, li] = w.grid[a][b];
      const self = a === b;
      const bg = self ? "var(--surface-2)" : divergingColor((wi + li) ? wi / (wi + li) : 0.5);
      return `<td style="background:${bg}${self ? ";outline:1px solid var(--gold-bright)" : ""}">${wi}-${li}</td>`;
    };
    return `<div class="card"><h2>Schedule What-If <span class="tag">${esc(season)} · your record with each manager's schedule</span></h2>
      <p class="note">Row = the team, column = whose schedule they play. The gold diagonal is what actually happened.</p>
      <div class="h2h-wrap"><table class="h2h">
      <tr><th></th>${w.uids.map(u => `<th>${esc(nameOf(u))}</th>`).join("")}</tr>
      ${w.uids.map(a => `<tr><th>${mgrChip(a)}</th>${w.uids.map(b => cell(a, b)).join("")}</tr>`).join("")}
      </table></div></div>`;
  }

  function luckCard(season) {
    if (season !== D.currentSeason) return "";
    return `<div class="card"><h2>All-Time Luck Index <span class="tag">actual win% minus all-play win% (regular season)</span></h2>
      <p class="note">All-play = your record if you played every team every week. Positive = the schedule has been your friend.</p>
      <div class="table-scroll"><table>
      <tr><th>Manager</th><th class="num">All-Play</th><th class="num">All-Play %</th><th class="num">Actual %</th><th class="num">Luck</th></tr>
      ${Object.entries(D.luck).sort((a, b) => b[1].luck - a[1].luck).map(([uid, L]) =>
        `<tr class="me-row"><td>${mgrChip(uid)}</td>
         <td class="num">${L.allPlayW}-${L.allPlayL}</td>
         <td class="num">${pct(L.allPlayPct)}</td><td class="num">${pct(L.actualPct)}</td>
         <td class="num" style="color:${L.luck >= 0 ? "var(--good)" : "var(--red)"}">${L.luck >= 0 ? "+" : ""}${(L.luck * 100).toFixed(1)}%</td></tr>`).join("")}
      </table></div></div>`;
  }

  /* ---------- SCHEDULE ---------- */
  const projCache = {};   // week -> {pid: proj pts}
  function fetchProjections(week) {
    if (projCache[week] || projCache["pending" + week]) return;
    projCache["pending" + week] = true;
    fetch(`https://api.sleeper.app/v1/projections/nfl/regular/${D.currentSeason}/${week}`)
      .then(r => r.json())
      .then(j => {
        const map = {};
        if (Array.isArray(j)) j.forEach(x => { if (x.player_id) map[x.player_id] = (x.stats || {}).pts_ppr || 0; });
        else Object.entries(j || {}).forEach(([pid, st]) => { map[pid] = (st || {}).pts_ppr || 0; });
        projCache[week] = map;
        if (state.view === "schedule" || state.view === "home") render();
      })
      .catch(() => { projCache[week] = {}; });
  }
  function projectedPts(week, uid) {
    const map = projCache[week];
    if (!map || !LIVE.loaded) return null;
    const rid = LIVE.rosters.find(r => r.owner_id === uid)?.roster_id;
    const row = (LIVE.matchups[week] || []).find(r => r.roster_id === rid);
    if (!row || !(row.starters || []).length) return null;
    const total = row.starters.reduce((s, pid) => s + (map[pid] || 0), 0);
    return total > 0 ? total : null;
  }

  function vSchedule() {
    const season = state.season;
    if (!state.weekTouched && season === D.currentSeason && LIVE.loaded) state.week = LIVE.week;
    const pw = D.seasonsData[season] ? D.seasonsData[season].playoffWeekStart : 15;
    const weeks = [];
    for (let w = 1; w <= 17; w++) weeks.push(w);
    const games = weekMatchups(season, state.week);
    const upcoming = season === D.currentSeason && LIVE.loaded && games.some(g => !g.played);
    if (upcoming) fetchProjections(state.week);
    return seasonPicker() + `
      <div class="week-nav">${weeks.map(w =>
        `<button data-week="${w}" class="${w === state.week ? "on" : ""}" title="${w >= pw ? "playoffs" : ""}">${w >= pw ? "P" + (w - pw + 1) : w}</button>`).join("")}
      </div>
      <div class="matchup-grid">${games.map(g => gameRow(g, { teamNames: true, proj: upcoming ? state.week : null })).join("") || '<p class="note">No games for this week' + (state.week >= pw ? " (bracket slot not played)" : "") + ".</p>"}</div>
      ${upcoming && projCache[state.week] ? '<p class="footnote">Projections: Sleeper PPR projections summed over each team’s current starters.</p>' : ""}`;
  }

  /* ---------- HEAD-TO-HEAD ---------- */
  function vH2H() {
    const uids = Object.keys(D.career).sort((a, b) => (seatOf[a] || 9) - (seatOf[b] || 9) || nameOf(a).localeCompare(nameOf(b)));
    const cell = (a, b) => {
      if (a === b) return '<td class="self"></td>';
      const r = (D.h2h[a] || {})[b];
      if (!r) return '<td class="self" style="color:var(--muted)">—</td>';
      const w = r.w + r.pw, l = r.l + r.pl, gp = w + l + r.t;
      const p = gp ? w / gp : 0.5;
      const bg = divergingColor(p);
      const po = (r.pw || r.pl) ? `<span class="sub">playoffs ${r.pw}-${r.pl}</span>` : "";
      return `<td style="background:${bg}" data-h2h="${esc(a)}|${esc(b)}">${w}-${l}${r.t ? "-" + r.t : ""}${po}</td>`;
    };
    return `<div class="card"><h2>All-Time Head-to-Head <span class="tag">row vs column · includes playoffs · click a cell for the game log</span></h2>
      <div class="h2h-wrap"><table class="h2h">
        <tr><th></th>${uids.map(u => `<th>${esc(nameOf(u))}</th>`).join("")}</tr>
        ${uids.map(a => `<tr><th>${mgrChip(a)}</th>${uids.map(b => cell(a, b)).join("")}</tr>`).join("")}
      </table></div>
      <p class="note" style="margin-top:10px">Blue = winning record, red = losing record, gray = even.</p></div>`;
  }
  function divergingColor(p) {
    // blue (#3987e5) <- gray (#383835) -> red (#e66767), p in [0,1], 0.5 = neutral
    const mix = (c1, c2, t) => {
      const h = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
      const [r1, g1, b1] = h(c1), [r2, g2, b2] = h(c2);
      return `rgb(${Math.round(r1 + (r2 - r1) * t)},${Math.round(g1 + (g2 - g1) * t)},${Math.round(b1 + (b2 - b1) * t)})`;
    };
    const t = Math.min(1, Math.abs(p - 0.5) * 2);
    return p >= 0.5 ? mix("#383835", "#1c5cab", t) : mix("#383835", "#a83e3e", t);
  }

  /* ---------- RECORD BOOK ---------- */
  function recTable(rows, cols) {
    return `<div class="table-scroll"><table>
      <tr><th></th>${cols.map(c => `<th class="${c.num ? "num" : ""}">${c.h}</th>`).join("")}</tr>
      ${rows.map((r, i) => `<tr class="me-row"><td class="rank-cell">${i + 1}</td>${cols.map(c => `<td class="${c.num ? "num" : ""}">${c.f(r)}</td>`).join("")}</tr>`).join("")}
    </table></div>`;
  }
  const gameCtx = r => `${r.season} · wk ${r.week}${r.type && r.type !== "regular" ? " · " + (typeLabel(r.type) || r.type).replace(/^..\s/, "") : ""}`;

  function vRecords() {
    const R = D.records;
    const single = [
      ["Highest Scores Ever", R.highScores, "pts"],
      ["Lowest Scores Ever", R.lowScores, "pts"],
    ].map(([title, rows]) => `<div class="card"><h2>${title}</h2>${recTable(rows.slice(0, 10), [
      { h: "Manager", f: r => mgrChip(r.uid) },
      { h: "Points", num: 1, f: r => `<b>${fmt(r.pts)}</b>` },
      { h: "vs", f: r => mgrChip(r.opp) },
      { h: "Opp Pts", num: 1, f: r => fmt(r.oppPts) },
      { h: "Result", f: r => r.tie ? "T" : (r.win ? '<span class="pill win">W</span>' : '<span class="pill loss">L</span>') },
      { h: "When", f: gameCtx },
    ])}</div>`).join("");

    const matchupCols = [
      { h: "Winner", f: r => mgrChip(r.hi.uid) },
      { h: "Score", num: 1, f: r => `<b>${fmt(r.hi.pts)}–${fmt(r.lo.pts)}</b>` },
      { h: "Loser", f: r => mgrChip(r.lo.uid) },
      { h: "Margin", num: 1, f: r => fmt(r.margin) },
      { h: "When", f: gameCtx },
    ];
    const pair = (t1, rows1, t2, rows2, cols) => `<div class="grid cols-2">
      <div class="card"><h2>${t1}</h2>${recTable(rows1, cols)}</div>
      <div class="card"><h2>${t2}</h2>${recTable(rows2, cols)}</div></div><div style="height:18px"></div>`;

    const teamGameCols = [
      { h: "Manager", f: r => mgrChip(r.uid) },
      { h: "Points", num: 1, f: r => `<b>${fmt(r.pts)}</b>` },
      { h: "vs", f: r => `${esc(nameOf(r.opp))} (${fmt(r.oppPts)})` },
      { h: "When", f: gameCtx },
    ];

    const seasonCols = [
      { h: "Manager", f: r => mgrChip(r.uid) },
      { h: "Season", f: r => r.season },
      { h: "Record", num: 1, f: r => `${r.wins}-${r.losses}` },
      { h: "PF", num: 1, f: r => `<b>${fmt(r.pf, 1)}</b>` },
      { h: "PPG", num: 1, f: r => fmt(r.ppg) },
      { h: "Finish", f: r => r.place === 1 ? '<span class="pill champ">CHAMP</span>' : r.place === 8 ? '<span class="pill sacko">SHITTER</span>' : (r.place ? ordinal(r.place) : "—") },
    ];

    const streakRows = Object.entries(D.streaks).map(([uid, s]) => ({ uid, ...s }));
    const wStreaks = streakRows.slice().sort((a, b) => b.maxW - a.maxW);
    const lStreaks = streakRows.slice().sort((a, b) => b.maxL - a.maxL);
    const span = sp => sp ? `${sp[0][0]} wk ${sp[0][1]} → ${sp[1][0]} wk ${sp[1][1]}` : "—";
    const streakCols = kind => [
      { h: "Manager", f: r => mgrChip(r.uid) },
      { h: kind === "W" ? "Wins in a row" : "Losses in a row", num: 1, f: r => `<b>${kind === "W" ? r.maxW : r.maxL}</b>` },
      { h: "Span", f: r => span(kind === "W" ? r.maxWspan : r.maxLspan) },
    ];

    const streaksBlock = `<div class="grid cols-2">
      <div class="card"><h2>Longest Win Streaks</h2>${recTable(wStreaks, streakCols("W"))}</div>
      <div class="card"><h2>Longest Losing Streaks</h2>${recTable(lStreaks, streakCols("L"))}</div>
    </div>`;

    return `
      <p class="note">Single-game records cover every regular-season and bracket game in league history (${D.completeSeasons[0]}–${D.completeSeasons[D.completeSeasons.length - 1]}). Consolation-week idle scores are excluded.</p>
      ${single}
      ${(E.playerRecords ? pair(
        "Greatest Player Performances", E.playerRecords.topStarters.slice(0, 12),
        "Best Games Ever Benched", E.playerRecords.topBenched.slice(0, 10), [
          { h: "Player", f: r => `<b>${pchip(r.pid)}</b> <small style="color:var(--muted)">${esc(ppos(r.pid))}</small>` },
          { h: "Points", num: 1, f: r => `<b>${fmt(r.pts)}</b>` },
          { h: "Manager", f: r => mgrChip(r.uid) },
          { h: "When", f: gameCtx },
        ]) : "")}
      ${pair("Biggest Blowouts", R.blowouts, "Closest Calls", R.nailbiters, matchupCols)}
      ${pair("Highest-Scoring Games", R.shootouts, "Lowest-Scoring Games", R.snoozers, matchupCols)}
      ${pair("Most Points in a Loss", R.bestLosses, "Fewest Points in a Win", R.worstWins, teamGameCols)}
      ${pair("Best Seasons (PF)", R.bestSeasonsPF, "Worst Seasons (PF)", R.worstSeasonsPF, seasonCols)}
      ${pair("Best Season Records", R.bestRecords, "Worst Season Records", R.worstRecords, seasonCols)}
      ${streaksBlock}`;
  }

  /* ---------- POWER RANKINGS ---------- */
  function powerSeries(season) {
    // weekly power score from games: 35% scoring, 30% all-play, 20% record, 15% last-3 form
    const sd = D.seasonsData[season];
    let games;
    if (season === D.currentSeason && LIVE.loaded) {
      games = [];
      for (let w = 1; w < D.currentLeague.playoffWeekStart; w++) {
        weekMatchups(season, w).forEach(g => { if (g.played) games.push(g); });
      }
    } else {
      games = sd.regularGames || [];
    }
    const weeks = [...new Set(games.map(g => g.week))].sort((a, b) => a - b);
    if (!weeks.length) return null;
    const uids = [...new Set(games.flatMap(g => [g.a.uid, g.b.uid]))];
    const byWeek = {};
    weeks.forEach(w => { byWeek[w] = games.filter(g => g.week === w); });
    const hist = {}; uids.forEach(u => hist[u] = []); // per-uid array of {pts, win}
    const series = {}; uids.forEach(u => series[u] = []);
    weeks.forEach(w => {
      byWeek[w].forEach(g => {
        hist[g.a.uid].push({ pts: g.a.pts, win: g.a.pts > g.b.pts });
        hist[g.b.uid].push({ pts: g.b.pts, win: g.b.pts > g.a.pts });
      });
      // all-play through this week
      const weekScores = {};
      weeks.filter(x => x <= w).forEach(x => byWeek[x].forEach(g => {
        (weekScores[x] = weekScores[x] || []).push([g.a.uid, g.a.pts], [g.b.uid, g.b.pts]);
      }));
      const ap = {}; uids.forEach(u => ap[u] = [0, 0]);
      Object.values(weekScores).forEach(list => list.forEach(([u, p]) => {
        list.forEach(([o, q]) => { if (o !== u) { if (p > q) ap[u][0]++; else if (p < q) ap[u][1]++; } });
      }));
      const ppgs = uids.map(u => hist[u].reduce((s, x) => s + x.pts, 0) / hist[u].length);
      const mn = Math.min(...ppgs), mx = Math.max(...ppgs);
      uids.forEach((u, i) => {
        const h = hist[u];
        const winPct = h.filter(x => x.win).length / h.length;
        const apPct = (ap[u][0] + ap[u][1]) ? ap[u][0] / (ap[u][0] + ap[u][1]) : 0.5;
        const norm = mx > mn ? (ppgs[i] - mn) / (mx - mn) : 0.5;
        const last3 = h.slice(-3);
        const l3ppg = last3.reduce((s, x) => s + x.pts, 0) / last3.length;
        const allL3 = uids.map(v => { const hh = hist[v].slice(-3); return hh.reduce((s, x) => s + x.pts, 0) / hh.length; });
        const l3mn = Math.min(...allL3), l3mx = Math.max(...allL3);
        const form = l3mx > l3mn ? (l3ppg - l3mn) / (l3mx - l3mn) : 0.5;
        series[u].push(Math.round((0.35 * norm + 0.30 * apPct + 0.20 * winPct + 0.15 * form) * 1000) / 10);
      });
    });
    return { weeks, uids, series };
  }

  function vPower() {
    if (!state.powerSeason) {
      state.powerSeason = (D.currentSeason === D.seasons[D.seasons.length - 1] && powerSeries(D.currentSeason))
        ? D.currentSeason : D.completeSeasons[D.completeSeasons.length - 1];
    }
    const season = state.powerSeason;
    const ps = powerSeries(season) || powerSeries(D.completeSeasons[D.completeSeasons.length - 1]);
    const opts = D.seasons.filter(s => powerSeries(s)).map(s =>
      `<option value="${s}" ${s === season ? "selected" : ""}>${s}</option>`).join("");
    if (!ps) return `<div class="card"><h2>Power Rankings</h2><p class="note">No games played yet.</p></div>`;
    const lastIdx = ps.weeks.length - 1;
    const ranked = ps.uids.map(u => ({
      uid: u, now: ps.series[u][lastIdx],
      prev: lastIdx > 0 ? ps.series[u][lastIdx - 1] : ps.series[u][lastIdx],
    })).sort((a, b) => b.now - a.now);
    const prevRank = ps.uids.map(u => ({ uid: u, v: lastIdx > 0 ? ps.series[u][lastIdx - 1] : 0 }))
      .sort((a, b) => b.v - a.v).map(x => x.uid);

    const odds = playoffOdds();
    const oddsCard = odds ? `<div class="card"><h2>Playoff Odds <span class="tag">${esc(D.currentSeason)} · 2,000 season simulations, updated live</span></h2>
      <div class="table-scroll"><table>
      <tr><th></th><th>Manager</th><th class="num">Playoffs</th><th style="min-width:140px"></th><th class="num">Div Title</th><th class="num">Shitter Game Risk</th></tr>
      ${odds.map((o, i) => `<tr class="me-row"><td class="rank-cell">${i + 1}</td><td>${mgrChip(o.uid)}</td>
        <td class="num"><b>${pct(o.po)}</b></td>
        <td><div class="ibar"><div class="track"><div class="fill" style="width:${(o.po * 100).toFixed(1)}%;background:${colorOf(o.uid)}"></div></div></div></td>
        <td class="num">${pct(o.div)}</td>
        <td class="num" style="color:${o.bot2 > 0.3 ? "var(--red)" : "inherit"}">${pct(o.bot2)}</td></tr>`).join("")}
      </table></div></div>` : "";
    return `
      <div class="controls"><label>Season</label><select id="power-season">${opts}</select></div>
      ${oddsCard}
      <div class="card"><h2>Power Rankings <span class="tag">through week ${ps.weeks[lastIdx]} · ${esc(season)}</span></h2>
        <p class="note">Formula: 35% season scoring · 30% all-play win% · 20% actual record · 15% last-3-week form.</p>
        <div class="table-scroll"><table>
        <tr><th></th><th>Manager</th><th class="num">Power</th><th style="min-width:160px"></th><th class="num">Move</th></tr>
        ${ranked.map((r, i) => {
          const mv = lastIdx > 0 ? prevRank.indexOf(r.uid) - i : 0;
          const arrow = mv > 0 ? `<span style="color:var(--good)">▲ ${mv}</span>` : mv < 0 ? `<span style="color:var(--red)">▼ ${-mv}</span>` : '<span style="color:var(--muted)">—</span>';
          return `<tr class="me-row"><td class="rank-cell">${i + 1}</td><td>${mgrChip(r.uid)}</td>
            <td class="num"><b>${fmt(r.now, 1)}</b></td>
            <td><div class="ibar"><div class="track"><div class="fill" style="width:${r.now}%;background:${colorOf(r.uid)}"></div></div></div></td>
            <td class="num">${arrow}</td></tr>`;
        }).join("")}
        </table></div></div>
      <div class="card"><h2>Trend <span class="tag">power score by week</span></h2>
        <div class="chart-box" id="power-chart">${lineChart(ps)}</div>
        <div class="legend" id="power-legend">${ps.uids.map(u =>
          `<span class="item" data-series="${esc(u)}"><span class="sw" style="background:${colorOf(u)}"></span>${esc(nameOf(u))}</span>`).join("")}</div>
      </div>`;
  }

  function lineChart(ps) {
    const W = 900, H = 340, padL = 46, padR = 110, padT = 16, padB = 30;
    const iw = W - padL - padR, ih = H - padT - padB;
    const n = ps.weeks.length;
    const x = i => padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
    const all = ps.uids.flatMap(u => ps.series[u]).filter(v => v != null);
    const range = Math.max(...all) - Math.min(...all);
    const step = range > 200 ? 50 : 10;
    const mn = Math.floor(Math.min(...all) / step) * step, mx = Math.ceil(Math.max(...all) / step) * step;
    const y = v => padT + ih - ((v - mn) / Math.max(1, mx - mn)) * ih;
    let out = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Trend chart">`;
    for (let g = mn; g <= mx; g += step) {
      out += `<line x1="${padL}" y1="${y(g)}" x2="${W - padR}" y2="${y(g)}" stroke="var(--grid)" stroke-width="1"/>`;
      out += `<text x="${padL - 8}" y="${y(g) + 4}" text-anchor="end" font-size="11" fill="var(--muted)">${g}</text>`;
    }
    // x labels: sparse mode labels only season changes ("2024 wk1" -> "2024")
    ps.weeks.forEach((w, i) => {
      if (ps.sparse) {
        const season = String(w).split(" ")[0];
        const prev = i > 0 ? String(ps.weeks[i - 1]).split(" ")[0] : null;
        if (season !== prev) {
          out += `<line x1="${x(i)}" y1="${padT}" x2="${x(i)}" y2="${padT + ih}" stroke="var(--baseline)" stroke-width="1" stroke-dasharray="3 4"/>`;
          out += `<text x="${x(i) + 4}" y="${H - 8}" font-size="11" fill="var(--muted)">${season}</text>`;
        }
      } else if (n <= 14 || i % 2 === 0) {
        out += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" font-size="11" fill="var(--muted)">${w}</text>`;
      }
    });
    // series lines (null-safe: split segments) + end labels (top 4 direct-labeled)
    const lastVal = u => { const s = ps.series[u]; for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) return s[i]; return -1e9; };
    const ends = ps.uids.map(u => ({ u, v: lastVal(u) })).sort((a, b) => b.v - a.v);
    const labelSet = new Set(ends.slice(0, 4).map(e => e.u));
    const usedY = [];
    ps.uids.forEach(u => {
      let seg = [];
      const segs = [];
      ps.series[u].forEach((v, i) => {
        if (v == null) { if (seg.length) segs.push(seg); seg = []; }
        else seg.push(`${x(i)},${y(v)}`);
      });
      if (seg.length) segs.push(seg);
      segs.forEach(sg => {
        out += `<polyline points="${sg.join(" ")}" fill="none" stroke="${colorOf(u)}" stroke-width="2" data-line="${esc(u)}"/>`;
      });
      if (labelSet.has(u) && lastVal(u) > -1e9) {
        let ly = y(lastVal(u));
        while (usedY.some(v => Math.abs(v - ly) < 13)) ly += 13;
        usedY.push(ly);
        out += `<text x="${W - padR + 8}" y="${ly + 4}" font-size="11.5" font-weight="600" fill="${colorOf(u)}" data-line="${esc(u)}">${esc(nameOf(u))}</text>`;
      }
    });
    out += `<rect class="chart-hit" x="${padL}" y="${padT}" width="${iw}" height="${ih}" fill="transparent"/>`;
    out += `<line class="chart-xhair" x1="0" y1="${padT}" x2="0" y2="${padT + ih}" stroke="var(--baseline)" stroke-width="1" style="display:none"/>`;
    out += `</svg><div class="viz-tip"></div>`;
    return out;
  }

  function wireChart(boxSel, ps, legendSel) {
    const box = $(boxSel); if (!box) return;
    const svg = $("svg", box), hit = $(".chart-hit", box), xh = $(".chart-xhair", box), tip = $(".viz-tip", box);
    const W = 900, padL = 46, padR = 110, iw = W - padL - padR;
    const n = ps.weeks.length;
    hit.addEventListener("mousemove", e => {
      const r = svg.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width * W;
      const i = Math.max(0, Math.min(n - 1, Math.round((px - padL) / Math.max(1, iw) * (n - 1))));
      const cx = padL + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
      xh.setAttribute("x1", cx); xh.setAttribute("x2", cx); xh.style.display = "";
      const rows = ps.uids.map(u => ({ u, v: ps.series[u][i] })).filter(x => x.v != null).sort((a, b) => b.v - a.v);
      tip.innerHTML = `<div class="t">${ps.sparse ? esc(ps.weeks[i]) : "Week " + ps.weeks[i]}</div>` + rows.map(x =>
        `<div class="r"><span><span class="sw" style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${colorOf(x.u)};margin-right:5px"></span>${esc(nameOf(x.u))}</span><b>${fmt(x.v, 1)}</b></div>`).join("");
      tip.style.display = "block";
      const bx = box.getBoundingClientRect();
      let tx = e.clientX - bx.left + 14;
      if (tx + 170 > bx.width) tx = e.clientX - bx.left - 184;
      tip.style.left = tx + "px";
      tip.style.top = Math.max(0, e.clientY - bx.top - 40) + "px";
    });
    hit.addEventListener("mouseleave", () => { tip.style.display = "none"; xh.style.display = "none"; });
    const legend = $(legendSel);
    legend?.addEventListener("click", e => {
      const it = e.target.closest(".item"); if (!it) return;
      it.classList.toggle("off");
      box.querySelectorAll(`[data-line="${CSS.escape(it.dataset.series)}"]`).forEach(line =>
        line.style.display = it.classList.contains("off") ? "none" : "");
    });
  }

  /* ---------- PICK'EM & POWER POLL ---------- */
  const PICKS_API = /[?&]devapi/.test(location.search) ? "http://localhost:8787" : "https://banditos-picks.lbffl.workers.dev";
  const pk = { week: null, sel: {}, poll: null, subs: null, season: null, msg: "", sending: false };

  const gameKey = g => [g.a.uid, g.b.uid].sort().join("|");

  async function loadPicksData(week) {
    try {
      const [subs, season] = await Promise.all([
        fetch(`${PICKS_API}/subs?season=${D.currentSeason}&week=${week}`).then(r => r.json()),
        pk.season || fetch(`${PICKS_API}/season?season=${D.currentSeason}`).then(r => r.json()),
      ]);
      pk.subs = subs; pk.season = season;
      if (state.view === "picks") render();
    } catch (e) { pk.subs = { error: true }; if (state.view === "picks") render(); }
  }

  function myIdentity() {
    try { return JSON.parse(localStorage.getItem("banditos_id") || "null"); } catch (e) { return null; }
  }

  async function submitPicks(week, games) {
    const uid = $("#pk-who")?.value, pin = $("#pk-pin")?.value.trim();
    if (!uid || !pin) { pk.msg = "Pick who you are and enter your PIN."; render(); return; }
    const picks = {};
    games.forEach(g => { const k = gameKey(g); if (pk.sel[k]) picks[k] = pk.sel[k]; });
    if (Object.keys(picks).length < games.length) { pk.msg = "Pick a winner in every game first."; render(); return; }
    pk.sending = true; pk.msg = ""; render();
    try {
      const r = await fetch(`${PICKS_API}/submit`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid, pin, season: D.currentSeason, week, picks, poll: pk.poll }),
      });
      const j = await r.json();
      if (j.ok) {
        localStorage.setItem("banditos_id", JSON.stringify({ uid, pin }));
        pk.msg = "✓ Submitted. You can resubmit until Thursday kickoff.";
        pk.subs = null; loadPicksData(week);
      } else pk.msg = "✗ " + (j.error || "failed");
    } catch (e) { pk.msg = "✗ network error"; }
    pk.sending = false; render();
  }

  function vPicks() {
    if (!LIVE.loaded) return '<div class="card"><p class="note">Connecting to Sleeper…</p></div>';
    const week = pk.week || LIVE.week || 1;
    pk.week = week;
    const games = weekMatchups(D.currentSeason, week).filter(g => g.type === "regular" || g.week < D.currentLeague.playoffWeekStart);
    if (pk.subs === null) { loadPicksData(week); }
    const active = currentStandings().map(s => s.uid);
    if (!pk.poll) {
      const ps = powerSeries(D.currentSeason);
      pk.poll = ps ? ps.uids.slice().sort((a, b) => ps.series[b][ps.series[b].length - 1] - ps.series[a][ps.series[a].length - 1]) : active.slice();
    }
    const me = myIdentity();
    const locked = pk.subs && pk.subs.locked;

    if (games.some(g => !g.played)) fetchProjections(week);
    const pickCards = games.map(g => {
      const k = gameKey(g);
      const odds = !g.played ? matchupOdds(g, week) : null;
      const btn = t => {
        const ml = odds ? (t.uid === g.a.uid ? odds.mlA : odds.mlB) : "";
        return `<button class="pk-team ${pk.sel[k] === t.uid ? "on" : ""}" data-pick="${esc(k)}" data-team="${esc(t.uid)}" ${locked ? "disabled" : ""}>
        ${avatarHtml(t.uid, 20)} ${esc(nameOf(t.uid))}${ml ? `<span class="ml-chip ${ml.startsWith("-") ? "fav" : ""}">${ml}</span>` : ""}</button>`;
      };
      let crowd = "";
      if (locked && pk.subs.subs?.length) {
        const votes = pk.subs.subs.filter(s => s.picks && s.picks[k]);
        if (votes.length) {
          const aPct = Math.round(votes.filter(s => s.picks[k] === g.a.uid).length / votes.length * 100);
          crowd = `<div class="grudge">Crowd: ${aPct}% ${esc(nameOf(g.a.uid))} · ${100 - aPct}% ${esc(nameOf(g.b.uid))}</div>`;
        }
      }
      return `<div class="matchup pk-game">${btn(g.a)}${btn(g.b)}${crowd}</div>`;
    }).join("");

    const pollRows = pk.poll.map((u, i) => `
      <div class="poll-row">
        <span class="rank-cell">${i + 1}</span>${mgrChip(u)}
        <span class="poll-btns">
          <button class="btn" data-pollmove="${esc(u)}|up" ${i === 0 || locked ? "disabled" : ""}>▲</button>
          <button class="btn" data-pollmove="${esc(u)}|down" ${i === pk.poll.length - 1 || locked ? "disabled" : ""}>▼</button>
        </span>
      </div>`).join("");

    const whoOpts = active.map(u => `<option value="${esc(u)}" ${me && me.uid === u ? "selected" : ""}>${esc(nameOf(u))}</option>`).join("");
    const submittedNote = pk.subs && !pk.subs.locked && pk.subs.submitted
      ? `<p class="note">${pk.subs.submitted.length}/8 in: ${pk.subs.submitted.map(nameOf).join(", ") || "nobody yet"}</p>` : "";

    /* leaderboard from locked weeks */
    let leader = "";
    if (pk.season) {
      const scores = {};
      Object.entries(pk.season).forEach(([wk, data]) => {
        if (!data.locked) return;
        const wkGames = weekMatchups(D.currentSeason, Number(wk)).filter(g => g.played);
        data.subs.forEach(s => {
          if (!s.picks) return;
          let pts = 0;
          wkGames.forEach(g => {
            const winner = g.a.pts > g.b.pts ? g.a.uid : g.b.pts > g.a.pts ? g.b.uid : null;
            if (winner && s.picks[gameKey(g)] === winner) pts++;
          });
          scores[s.uid] = (scores[s.uid] || 0) + pts;
        });
      });
      const rows = Object.entries(scores).sort((a, b) => b[1] - a[1]);
      if (rows.length) {
        leader = `<div class="card"><h2>Pick'em Leaderboard <span class="tag">1 pt per correct pick · season-long</span></h2>
          <div class="table-scroll"><table><tr><th></th><th>Manager</th><th class="num">Correct</th></tr>
          ${rows.map(([u, p], i) => `<tr class="me-row"><td class="rank-cell">${i + 1}</td><td>${mgrChip(u)}</td><td class="num"><b>${p}</b></td></tr>`).join("")}
          </table></div></div>`;
      }
      /* league poll aggregate for this week (if locked) */
      const wkData = pk.season[String(week)];
      if (wkData?.locked) {
        const ranks = {};
        wkData.subs.forEach(s => (s.poll || []).forEach((u, i) => { (ranks[u] = ranks[u] || []).push(i + 1); }));
        const agg = Object.entries(ranks).map(([u, rs]) => ({ u, avg: rs.reduce((a, b) => a + b, 0) / rs.length }))
          .sort((a, b) => a.avg - b.avg);
        if (agg.length) {
          leader += `<div class="card"><h2>League Poll <span class="tag">week ${week} · average rank from ${wkData.subs.length} ballots</span></h2>
            <div class="table-scroll"><table><tr><th></th><th>Team</th><th class="num">Avg Rank</th></tr>
            ${agg.map((r, i) => `<tr class="me-row"><td class="rank-cell">${i + 1}</td><td>${mgrChip(r.u)}</td><td class="num">${r.avg.toFixed(1)}</td></tr>`).join("")}
            </table></div></div>`;
        }
      }
    }

    return `
      <div class="card"><h2>Week ${week} Pick'em ${locked ? '<span class="pill sacko">LOCKED</span>' : '<span class="pill live">OPEN</span>'}
        <span class="tag">${locked ? "games have started — picks are in" : "locks at Thursday kickoff · resubmit anytime before"}</span></h2>
        ${submittedNote}
        <div class="matchup-grid">${pickCards || '<p class="note">No matchups this week.</p>'}</div>
        <div class="section-title">Power Poll — rank the league</div>
        <div class="poll-list">${pollRows}</div>
        ${locked ? "" : `<div class="controls" style="margin-top:16px">
          <label>I am</label><select id="pk-who">${whoOpts}</select>
          <input id="pk-pin" type="password" inputmode="numeric" placeholder="PIN" value="${me ? esc(me.pin) : ""}"
            style="background:var(--surface-2);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:7px 10px;width:80px;font-family:inherit">
          <button class="btn on" id="pk-submit" ${pk.sending ? "disabled" : ""}>${pk.sending ? "Sending…" : "Submit picks + poll"}</button>
          <span class="note" style="margin:0">${esc(pk.msg)}</span></div>`}
      </div>
      ${leader}
      <p class="footnote">Don't know your PIN? Ask the commissioner. Picks are hidden from everyone until the week locks.</p>`;
  }

  /* ---------- HOT TAKES ---------- */
  const HT = { pending: false, loaded: false, failed: false, takes: [], reacts: {}, grades: {}, gradeThrough: -1 };
  const htWeek = () => (LIVE.loaded ? LIVE.week : 1);
  const htVotes = (map, week, takeUid) => Object.values(map[`${week}:${takeUid}`] || {});
  const htMyVote = (map, week, takeUid) => {
    const me = myIdentity();
    return me ? (map[`${week}:${takeUid}`] || {})[me.uid] || null : null;
  };

  async function loadTakes(force) {
    if (HT.pending || (HT.loaded && !force)) return;
    HT.pending = true;
    try {
      const j = await fetch(`${PICKS_API}/takes?season=${D.currentSeason}`).then(r => r.json());
      if (!Array.isArray(j.takes)) throw new Error("backend has no /takes yet"); // old worker — stay hidden
      HT.takes = j.takes; HT.reacts = j.reacts || {}; HT.grades = j.grades || {};
      HT.gradeThrough = j.gradeableThroughWeek ?? -1;
      HT.loaded = true; HT.failed = false;
    } catch (e) { HT.failed = true; }
    HT.pending = false;
    maybeTakePrompt();
    if (state.view === "home" || state.view === "takes") render();
  }

  /* the on-open prompt: once per browser session, until this week's take is filed */
  function maybeTakePrompt() {
    if (!HT.loaded || !LIVE.loaded) return;
    if (sessionStorage.getItem("ht_prompted")) return;
    const me = myIdentity();
    if (me && HT.takes.some(t => t.uid === me.uid && t.week === htWeek())) return;
    if (document.querySelector(".modal-back")) return;
    sessionStorage.setItem("ht_prompted", "1");
    openTakeModal();
  }

  function openTakeModal() {
    const me = myIdentity();
    const wk = htWeek();
    const mine = me ? HT.takes.find(t => t.uid === me.uid && t.week === wk) : null;
    const active = currentStandings().map(s => s.uid);
    const whoOpts = active.map(u => `<option value="${esc(u)}" ${me && me.uid === u ? "selected" : ""}>${esc(nameOf(u))}</option>`).join("");
    showModal(`
      <button class="close" data-close>×</button>
      <h3>🌶️ Hot Take of the Week <small style="color:var(--muted);font-weight:400">week ${wk}</small></h3>
      <p class="note">Drop your football or fantasy take. It posts instantly for the whole league and is editable until Thursday kickoff — then it's on the record, and three weeks later the league grades it 🍷 or 🥛.</p>
      <textarea id="ht-text" maxlength="280" rows="3" placeholder="The spicier the better…"
        style="width:100%;background:var(--surface-2);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-family:inherit;font-size:14px;resize:vertical">${mine ? esc(mine.text) : ""}</textarea>
      <div class="controls" style="margin-top:10px">
        <label>I am</label><select id="ht-who">${whoOpts}</select>
        <input id="ht-pin" type="password" inputmode="numeric" placeholder="PIN" value="${me ? esc(me.pin) : ""}"
          style="background:var(--surface-2);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:7px 10px;width:80px;font-family:inherit">
        <button class="btn on" id="ht-submit">${mine ? "Update take" : "Post it"}</button>
        <span class="note" style="margin:0" id="ht-msg"></span>
      </div>`);
  }

  async function submitTake() {
    const text = ($("#ht-text")?.value || "").trim();
    const uid = $("#ht-who")?.value, pin = ($("#ht-pin")?.value || "").trim();
    const say = m => { const el = $("#ht-msg"); if (el) el.textContent = m; };
    if (text.length < 3) { say("Type an actual take first."); return; }
    if (!uid || !pin) { say("Pick who you are and enter your PIN."); return; }
    say("Sending…");
    try {
      const r = await fetch(`${PICKS_API}/take`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid, pin, season: D.currentSeason, week: htWeek(), text }),
      });
      const j = await r.json();
      if (j.ok) {
        localStorage.setItem("banditos_id", JSON.stringify({ uid, pin }));
        closeModal();
        loadTakes(true);
      } else say("✗ " + (j.error || "failed"));
    } catch (e) { say("✗ network error"); }
  }

  async function voteTake(kind, week, takeUid, vote) {
    const me = myIdentity();
    if (!me) { openTakeModal(); return; } // no identity yet — the take modal saves one
    try {
      const r = await fetch(`${PICKS_API}/${kind === "grade" ? "grade" : "react"}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: me.uid, pin: me.pin, season: D.currentSeason, week: Number(week), takeUid, vote }),
      });
      const j = await r.json();
      if (j.ok) loadTakes(true);
      else console.warn("vote failed:", j.error);
    } catch (e) { console.warn("vote failed", e); }
  }

  function takeCard(t) {
    const rs = htVotes(HT.reacts, t.week, t.uid);
    const fire = rs.filter(v => v === "fire").length, trash = rs.filter(v => v === "trash").length;
    const myR = htMyVote(HT.reacts, t.week, t.uid);
    const me = myIdentity();
    const own = me && me.uid === t.uid;
    let gradeHtml = "";
    if (t.week <= HT.gradeThrough) {
      const gs = htVotes(HT.grades, t.week, t.uid);
      const wine = gs.filter(v => v === "wine").length, milk = gs.filter(v => v === "milk").length;
      const myG = htMyVote(HT.grades, t.week, t.uid);
      const verdict = wine + milk >= 3
        ? (wine > milk ? '<span class="pill champ">🍷 AGED LIKE WINE</span>' : milk > wine ? '<span class="pill sacko">🥛 AGED LIKE MILK</span>' : "")
        : "";
      gradeHtml = `<div class="take-actions">
        <button class="btn tiny ${myG === "wine" ? "on" : ""}" data-grade="${t.week}|${esc(t.uid)}|wine">🍷 ${wine}</button>
        <button class="btn tiny ${myG === "milk" ? "on" : ""}" data-grade="${t.week}|${esc(t.uid)}|milk">🥛 ${milk}</button>
        ${verdict}</div>`;
    }
    return `<div class="take">
      <div class="take-head">${mgrChip(t.uid)} <small style="color:var(--muted)">week ${t.week}</small></div>
      <div class="take-text">“${esc(t.text)}”</div>
      <div class="take-actions">
        <button class="btn tiny ${myR === "fire" ? "on" : ""}" data-react="${t.week}|${esc(t.uid)}|fire" ${own ? 'disabled title="no self-hype"' : ""}>🔥 ${fire}</button>
        <button class="btn tiny ${myR === "trash" ? "on" : ""}" data-react="${t.week}|${esc(t.uid)}|trash" ${own ? "disabled" : ""}>🗑️ ${trash}</button>
      </div>
      ${gradeHtml}
    </div>`;
  }

  function htHomeCard() {
    if (!HT.loaded) return "";
    const wk = htWeek();
    const weekTakes = HT.takes.filter(t => t.week === wk);
    const me = myIdentity();
    const minePosted = me && weekTakes.some(t => t.uid === me.uid);
    return `<div class="card"><h2>🌶️ Hot Takes <span class="tag">week ${wk} · ${weekTakes.length}/8 filed · <a href="#/takes">archive &amp; grades →</a></span></h2>
      ${weekTakes.length ? `<div class="takes-grid">${weekTakes.map(takeCard).join("")}</div>` : '<p class="note">Nobody has said anything reckless yet this week. Be first.</p>'}
      ${minePosted ? "" : `<div class="controls" style="margin-top:12px"><button class="btn on" id="ht-open">🌶️ Drop your week ${wk} take</button></div>`}
    </div>`;
  }

  function vTakes() {
    if (!HT.loaded) {
      loadTakes();
      return HT.failed
        ? '<div class="card"><h2>Hot Takes</h2><p class="note">The takes backend isn’t reachable — worker not deployed yet, or you’re offline.</p></div>'
        : '<div class="card"><p class="note">Loading takes…</p></div>';
    }
    const wk = htWeek();
    /* Nostradamus standings: net 🍷 minus 🥛 across all graded takes */
    const byAuthor = {};
    HT.takes.forEach(t => {
      const gs = htVotes(HT.grades, t.week, t.uid);
      const a = (byAuthor[t.uid] = byAuthor[t.uid] || { takes: 0, wine: 0, milk: 0 });
      a.takes++;
      a.wine += gs.filter(v => v === "wine").length;
      a.milk += gs.filter(v => v === "milk").length;
    });
    const lb = Object.entries(byAuthor).filter(([, a]) => a.wine + a.milk > 0)
      .sort((x, y) => (y[1].wine - y[1].milk) - (x[1].wine - x[1].milk));
    const lbCard = lb.length ? `<div class="card"><h2>Nostradamus Standings <span class="tag">net 🍷 across every graded take</span></h2>
      <div class="table-scroll"><table>
      <tr><th></th><th>Manager</th><th class="num">Takes</th><th class="num">🍷</th><th class="num">🥛</th><th class="num">Net</th></tr>
      ${lb.map(([u, a], i) => `<tr class="me-row"><td class="rank-cell">${i + 1}</td>
        <td>${mgrChip(u)}${i === 0 && a.wine > a.milk ? ' <span class="pill champ">🔮 NOSTRADAMUS</span>' : i === lb.length - 1 && lb.length > 1 && a.milk > a.wine ? ' <span class="pill sacko">🤡 CLOWN</span>' : ""}</td>
        <td class="num">${a.takes}</td><td class="num">${a.wine}</td><td class="num">${a.milk}</td>
        <td class="num" style="color:${a.wine - a.milk >= 0 ? "var(--good)" : "var(--red)"}"><b>${a.wine - a.milk >= 0 ? "+" : ""}${a.wine - a.milk}</b></td></tr>`).join("")}
      </table></div></div>` : "";
    const pastWeeks = [...new Set(HT.takes.filter(t => t.week !== wk).map(t => t.week))].sort((a, b) => b - a);
    const me = myIdentity();
    const weekTakes = HT.takes.filter(t => t.week === wk);
    const minePosted = me && weekTakes.some(t => t.uid === me.uid);
    return `
      <div class="card"><h2>🌶️ Hot Takes — Week ${wk}</h2>
        <p class="note">One take per manager per week. Editable until Thursday kickoff, then it’s on the record — and three weeks later the league votes 🍷 aged-like-wine or 🥛 aged-like-milk.</p>
        ${weekTakes.length ? `<div class="takes-grid">${weekTakes.map(takeCard).join("")}</div>` : '<p class="note">No takes filed yet.</p>'}
        ${minePosted ? "" : `<div class="controls" style="margin-top:12px"><button class="btn on" id="ht-open">🌶️ Drop your take</button></div>`}
      </div>
      ${wyrCard()}
      ${pushCard()}
      ${lbCard}
      ${pastWeeks.map(w => `<div class="card"><h2>Week ${w} <span class="tag">${w <= HT.gradeThrough ? "grading open — how did these age?" : "on the record · grading opens week " + (w + 3)}</span></h2>
        <div class="takes-grid">${HT.takes.filter(t => t.week === w).map(takeCard).join("")}</div></div>`).join("")}
      <p class="footnote">Reactions and grades are one vote per manager, signed with your Pick'em PIN. You can’t 🔥 your own take. A take needs 3+ grades for an official verdict.</p>`;
  }

  /* ---------- push notification reminders ---------- */
  const VAPID_PUBLIC = "BNuvGGc7igXPBD3jWmH5tKSZQwLFLSDMCFvkF7Mj_xJAZoiXkwD-jjcpX5yaNAtrOmKvnRIAhkW85_8CHePRnrs";
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  function urlB64ToU8(s) {
    const pad = "=".repeat((4 - s.length % 4) % 4);
    const b = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(b, c => c.charCodeAt(0));
  }
  const pushSay = m => { const el = $("#push-msg"); if (el) el.textContent = m; };

  async function enablePush() {
    const me = myIdentity();
    if (!me) { openTakeModal(); return; } // capture identity first (saves PIN)
    if (!pushSupported()) {
      pushSay("Not supported in this browser. On iPhone: Share → Add to Home Screen, then enable inside the installed app.");
      return;
    }
    try {
      pushSay("Asking permission…");
      const perm = await Notification.requestPermission();
      if (perm !== "granted") { pushSay("Notifications were blocked — allow them in Settings and retry."); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(VAPID_PUBLIC) });
      const j = await fetch(`${PICKS_API}/push/subscribe`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: me.uid, pin: me.pin, sub: sub.toJSON() }),
      }).then(r => r.json());
      if (j.ok) { localStorage.setItem("banditos_push", "1"); render(); }
      else pushSay("✗ " + (j.error || "failed"));
    } catch (e) { pushSay("✗ " + (e.message || e)); }
  }

  async function testPush() {
    const me = myIdentity();
    if (!me) return;
    pushSay("Sending…");
    try {
      const j = await fetch(`${PICKS_API}/push/test`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: me.uid, pin: me.pin }),
      }).then(r => r.json());
      pushSay(j.ok ? (j.sent ? `✓ Sent to ${j.sent} device${j.sent > 1 ? "s" : ""} — check your notifications.` : "No live subscriptions found — re-enable and try again.") : "✗ " + (j.error || "failed"));
    } catch (e) { pushSay("✗ network error"); }
  }

  function pushCard() {
    const on = localStorage.getItem("banditos_push");
    return `<div class="card"><h2>🔔 Reminders <span class="tag">straight to your phone</span></h2>
      <p class="note">Two nudges a week, and only when you're the one holding things up: <b>Wednesday 6pm</b> if your hot take isn't in, and <b>Thursday 4pm</b> during the season if your picks aren't in before lock. iPhone: install the app first (Share → Add to Home Screen), then enable in the installed app.</p>
      <div class="controls">
        ${on
          ? '<span class="pill live">ENABLED ON THIS DEVICE</span> <button class="btn" id="push-test">Send test</button> <button class="btn" id="push-off">Disable</button>'
          : '<button class="btn on" id="push-enable">🔔 Enable notifications</button>'}
        <span class="note" style="margin:0" id="push-msg"></span>
      </div></div>`;
  }

  async function disablePush() {
    const me = myIdentity();
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        if (me) await fetch(`${PICKS_API}/push/unsubscribe`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ uid: me.uid, pin: me.pin, endpoint: sub.endpoint }),
        });
        await sub.unsubscribe();
      }
    } catch (e) { /* best effort */ }
    localStorage.removeItem("banditos_push");
    render();
  }

  /* ---------- WHO YA RATHER (weekly player poll) ---------- */
  const WYR = { pending: false, loaded: false, failed: false, seeding: false, pairs: {}, votes: {} };

  async function loadWyr(force) {
    if (WYR.pending || (WYR.loaded && !force)) return;
    WYR.pending = true;
    try {
      const j = await fetch(`${PICKS_API}/wyr?season=${D.currentSeason}`).then(r => r.json());
      if (!j.pairs || !j.votes) throw new Error("backend has no /wyr yet");
      WYR.pairs = j.pairs; WYR.votes = j.votes;
      WYR.loaded = true; WYR.failed = false;
    } catch (e) { WYR.failed = true; }
    WYR.pending = false;
    ensureWyrPairs();
    if (state.view === "home" || state.view === "takes") render();
  }

  /* deterministic-ish weekly pairs: close in market value (±5-ish rank spots), mostly same position */
  function wyrGenerate(week) {
    const pool = Object.entries(TF.val).map(([sid, p]) => ({ sid, ...p }))
      .filter(p => TF_POS.includes(p.pos) && p.v > 0)
      .sort((a, b) => b.v - a.v).slice(0, 80);
    const cands = [];
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j <= i + 6 && j < pool.length; j++) {
        const a = pool[i], b = pool[j];
        if (b.v / a.v < 0.85) continue; // keep it close — no Puka vs DeVonta
        cands.push({ a, b, samePos: a.pos === b.pos });
      }
    }
    let h = 0;
    const seedStr = `${D.currentSeason}-wyr-${week}`;
    for (let i = 0; i < seedStr.length; i++) h = (Math.imul(h, 31) + seedStr.charCodeAt(i)) | 0;
    const rand = () => {
      h = (h + 0x6D2B79F5) | 0;
      let t = Math.imul(h ^ (h >>> 15), 1 | h);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const chosen = [], used = new Set();
    const pick = list => {
      const l = list.filter(c => !used.has(c.a.sid) && !used.has(c.b.sid));
      if (!l.length) return;
      const c = l[Math.floor(rand() * l.length)];
      chosen.push([c.a.sid, c.b.sid]); used.add(c.a.sid); used.add(c.b.sid);
    };
    pick(cands.filter(c => c.samePos));
    pick(cands.filter(c => c.samePos));
    pick(cands);
    return chosen;
  }

  /* first visitor of the week seeds the pairs; the worker keeps the first write so everyone votes the same poll */
  async function ensureWyrPairs() {
    if (!WYR.loaded || !TF.loaded || !LIVE.loaded || WYR.seeding) return;
    const wk = htWeek();
    if (WYR.pairs[String(wk)]) return;
    const pairs = wyrGenerate(wk);
    if (!pairs.length) return;
    WYR.seeding = true;
    try {
      const j = await fetch(`${PICKS_API}/wyrpairs`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ season: D.currentSeason, week: wk, pairs }),
      }).then(r => r.json());
      if (j.pairs) { WYR.pairs[String(wk)] = j.pairs; if (state.view === "home" || state.view === "takes") render(); }
    } catch (e) { /* next load retries */ }
    WYR.seeding = false;
  }

  async function wyrVote(week, pairKey, pick) {
    const me = myIdentity();
    if (!me) { openTakeModal(); return; } // saves an identity we can sign votes with
    try {
      const j = await fetch(`${PICKS_API}/wyrvote`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uid: me.uid, pin: me.pin, season: D.currentSeason, week: Number(week), pairKey, pick }),
      }).then(r => r.json());
      if (j.ok) loadWyr(true);
      else console.warn("wyr vote failed:", j.error);
    } catch (e) { console.warn("wyr vote failed", e); }
  }

  function wyrCard() {
    if (!WYR.loaded || !TF.loaded) return "";
    const wk = htWeek();
    const pairs = WYR.pairs[String(wk)];
    if (!pairs || !pairs.length) return "";
    const me = myIdentity();
    const rows = pairs.map(([a, b]) => {
      const pairKey = `${a}|${b}`;
      const votes = WYR.votes[`${wk}:${pairKey}`] || {};
      const myPick = me ? votes[me.uid] : null;
      const n = Object.keys(votes).length;
      const side = sid => {
        const p = TF.val[sid] || { name: "#" + sid, pos: "", team: "", age: null };
        const cnt = Object.values(votes).filter(v => v === sid).length;
        const pctv = n ? Math.round(cnt / n * 100) : 0;
        const on = myPick === sid;
        return `<button class="wyr-side ${on ? "on" : ""}" data-wyr="${wk}|${esc(pairKey)}|${esc(sid)}">
          <span class="wyr-name">${esc(p.name)}</span>
          <span class="wyr-sub">${esc(p.pos)}${p.team ? " · " + esc(p.team) : ""}${p.age ? " · " + Math.round(p.age) + "y" : ""}</span>
          ${myPick ? `<span class="wyr-pct">${pctv}%</span><span class="wyr-bar"><span style="width:${pctv}%"></span></span>` : ""}
        </button>`;
      };
      return `<div class="wyr-row">${side(a)}<span class="wyr-or">or</span>${side(b)}
        <div class="wyr-meta">${myPick ? `${n} vote${n === 1 ? "" : "s"} in` : n ? `${n} voted — pick a side to see the split` : "no votes yet — set the tone"}</div></div>`;
    }).join("");
    return `<div class="card"><h2>🤔 Who Ya Rather <span class="tag">week ${wk} · dynasty, this league's format · results after you vote</span></h2>
      <div class="wyr-grid">${rows}</div></div>`;
  }

  /* ---------- SEASON PREVIEW MAGAZINE ---------- */
  function vPreview() {
    loadTradeValues(); // market values enrich the capsules once loaded
    const lastS = D.completeSeasons[D.completeSeasons.length - 1];
    const active = currentStandings().map(s => s.uid);
    const eloMap = {}; ((E.elo || {}).table || []).forEach(r => eloMap[r.uid] = r.elo);
    const tm = TF.loaded ? tradeModel() : null;
    const val = u => tm ? tm.teams[u].total : 0;

    /* composite outlook: Elo (proven quality) + market value (roster talent) */
    const zs = arr => {
      const m = arr.reduce((a, b) => a + b, 0) / arr.length;
      const sd = Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length) || 1;
      return x => (x - m) / sd;
    };
    const zE = zs(active.map(u => eloMap[u] || 1500));
    const zV = tm ? zs(active.map(val)) : null;
    const comp = {}; active.forEach(u => { comp[u] = zE(eloMap[u] || 1500) + (zV ? zV(val(u)) : 0); });
    const order = active.slice().sort((a, b) => comp[b] - comp[a]);
    const cm = order.reduce((s, u) => s + comp[u], 0) / order.length;
    const winsOf = u => Math.max(3, Math.min(11, Math.round((7 + (comp[u] - cm) * 1.6) * 2) / 2));
    const ex = order.map(u => Math.exp(comp[u] * 0.55));
    const sx = ex.reduce((a, b) => a + b, 0);
    const oddsOf = {}; order.forEach((u, i) => { oddsOf[u] = ex[i] / sx; });
    const vRank = {}; active.slice().sort((a, b) => val(b) - val(a)).forEach((u, i) => { vRank[u] = i + 1; });
    const ages = tm ? active.map(u => tm.teams[u].wAge) : [];
    const aMin = Math.min(...ages), aMax = Math.max(...ages);

    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    const blurb = u => {
      const st = D.seasonsData[lastS].standings.find(x => x.uid === u);
      const bits = [];
      if (st) {
        if (st.place === 1) bits.push(`the defending champs run it back`);
        else if (st.place === 8) bits.push(`fresh off the Shitter, there is nowhere to go but up`);
        else if (st.place <= 3) bits.push(`coming off a ${ordinal(st.place)}-place finish at ${st.wins}-${st.losses}, the window is open`);
        else bits.push(`last year's ${st.wins}-${st.losses} campaign ended in ${ordinal(st.place)} — this roster wants more`);
      }
      const cs = (D.currentStreaks || {})[u];
      if (cs && cs.n >= 3) bits.push(cs.kind === "W" ? `they carry a ${cs.n}-game win streak into the opener` : `they need to snap a ${cs.n}-game skid first`);
      if (tm) {
        const t = tm.teams[u];
        const spec = aMax > aMin ? (t.wAge - aMin) / (aMax - aMin) : 0.5;
        bits.push(`the market ranks this the #${vRank[u]} asset base in the league${spec > 0.65 ? " — built to win right now" : spec < 0.35 ? " — young and still compounding" : ""}`);
        if (t.trend >= 800) bits.push(`the arrow points up: +${fmt(t.trend, 0)} in market value over the last 30 days`);
        else if (t.trend <= -800) bits.push(`the market has cooled on them lately (${fmt(t.trend, 0)} in 30 days)`);
        if (t.players[0]) bits.push(`everything routes through ${t.players[0].name}`);
      }
      const nem = Object.entries(D.h2h[u] || {})
        .map(([o, r]) => ({ o, w: r.w + r.pw, l: r.l + r.pl }))
        .filter(x => x.w + x.l >= 5 && active.includes(x.o) && x.l > x.w)
        .sort((a, b) => (a.w / (a.w + a.l)) - (b.w / (b.w + b.l)))[0];
      if (nem) bits.push(`the boogeyman remains ${nameOf(nem.o)} (${nem.w}-${nem.l} lifetime)`);
      return bits.map(cap).join(". ") + ".";
    };

    const capsule = (u, i) => {
      const rookies = (D.drafts[D.currentSeason] || []).flatMap(b => b.picks).filter(p => p.uid === u).slice(0, 2).map(p => p.player);
      const trades = (E.trades || []).filter(t => t.season === D.currentSeason && t.sides.some(s => s.uid === u)).length;
      const moves = [rookies.length ? `drafted ${rookies.join(" & ")}` : "", trades ? `${trades} trade${trades > 1 ? "s" : ""} made` : ""].filter(Boolean).join(" · ");
      return `<div class="card">
        <h2>#${i + 1} · ${esc(teamOf(u, D.currentSeason))} <span class="tag">${esc(nameOf(u))}</span></h2>
        <p class="note" style="margin-top:4px">O/U <b>${winsOf(u)}</b> wins · title odds <b>${pct(oddsOf[u])}</b> · Elo ${fmt(eloMap[u] || 1500, 0)}${tm ? ` · roster value ${fmt(val(u), 0)}` : ""}</p>
        <p style="margin:10px 0 6px;color:var(--ink-2)">${esc(blurb(u))}</p>
        ${moves ? `<p class="note">Offseason: ${esc(moves)}</p>` : ""}
      </div>`;
    };

    const maxOdds = Math.max(...order.map(u => oddsOf[u]));
    return `
      <div class="card">
        <h2>The ${esc(D.currentSeason)} Season Preview <span class="tag">auto-written from Elo, market values, streaks &amp; history</span></h2>
        <p class="note">Projected order blends each team's all-time Elo with its current dynasty-market roster value. Win totals are over/unders on a 14-game season — argue accordingly.</p>
        <div class="table-scroll"><table>
        <tr><th></th><th>Team</th><th class="num">O/U Wins</th><th class="num">Title Odds</th><th style="min-width:140px"></th></tr>
        ${order.map((u, i) => `<tr class="me-row"><td class="rank-cell">${i + 1}</td>
          <td>${mgrChip(u, { label: teamOf(u, D.currentSeason), sub: nameOf(u) })}</td>
          <td class="num"><b>${winsOf(u)}</b></td>
          <td class="num">${pct(oddsOf[u])}</td>
          <td><div class="ibar"><div class="track"><div class="fill" style="width:${(oddsOf[u] / maxOdds * 100).toFixed(1)}%;background:${colorOf(u)}"></div></div></div></td></tr>`).join("")}
        </table></div>
        ${tm ? "" : '<p class="note">Pricing rosters — market values loading…</p>'}
      </div>
      <div class="grid cols-2">${order.map(capsule).join("")}</div>
      <p class="footnote">Every word generated from league data: Elo ratings, FantasyCalc dynasty values, active streaks, head-to-head history, and this offseason's moves. Nobody wrote your capsule — the numbers did.</p>`;
  }

  /* ---------- ELO RATINGS ---------- */
  function vElo() {
    const el = E.elo;
    if (!el) return '<div class="card"><p class="note">Elo data not built yet.</p></div>';
    const ps = { weeks: el.weeks, uids: Object.keys(el.series), series: el.series, sparse: true };
    const maxElo = Math.max(...el.table.map(r => r.elo));
    const minElo = Math.min(...el.table.map(r => r.elo));
    return `
      <div class="card"><h2>All-Time Elo Ratings <span class="tag">every game since 2023 · K=32 · playoffs included</span></h2>
        <p class="note">Everyone starts at 1500. Beating a strong team moves you more than beating a weak one — this is the "who's actually good" number, schedule-proof.</p>
        <div class="table-scroll"><table>
        <tr><th></th><th>Manager</th><th class="num">Elo</th><th style="min-width:160px"></th><th class="num">Peak</th><th class="num">Peak Date</th></tr>
        ${el.table.map((r, i) => `<tr class="me-row"><td class="rank-cell">${i + 1}</td>
          <td>${mgrChip(r.uid)}${r.active ? "" : ' <small style="color:var(--muted)">(former)</small>'}</td>
          <td class="num"><b style="color:${r.elo >= 1500 ? "var(--good)" : "var(--red)"}">${fmt(r.elo, 0)}</b></td>
          <td><div class="ibar"><div class="track"><div class="fill" style="width:${((r.elo - minElo + 20) / (maxElo - minElo + 20) * 100).toFixed(1)}%;background:${colorOf(r.uid)}"></div></div></div></td>
          <td class="num">${fmt(r.peak, 0)}</td><td class="num">${esc(r.peakWhen)}</td></tr>`).join("")}
        </table></div></div>
      <div class="card"><h2>Elo History <span class="tag">click a name in the legend to hide a line</span></h2>
        <div class="chart-box" id="elo-chart">${lineChart(ps)}</div>
        <div class="legend" id="elo-legend">${ps.uids.map(u =>
          `<span class="item" data-series="${esc(u)}"><span class="sw" style="background:${colorOf(u)}"></span>${esc(nameOf(u))}</span>`).join("")}</div>
      </div>`;
  }

  /* ---------- PLAYER PASSPORTS ---------- */
  const pchip = pid => `<span class="pl" data-player="${esc(pid)}">${esc(pname(pid))}</span>`;

  function vPlayers() {
    const P = E.passports || {};
    const q = (state.playerQuery || "").toLowerCase();
    let rows;
    if (q.length >= 2) {
      rows = Object.keys(P).filter(pid => pname(pid).toLowerCase().includes(q))
        .sort((a, b) => P[b].stints.reduce((s, x) => s + x.pts, 0) - P[a].stints.reduce((s, x) => s + x.pts, 0)).slice(0, 25);
    } else {
      rows = Object.keys(P).sort((a, b) => P[b].owners - P[a].owners ||
        P[b].events.length - P[a].events.length).slice(0, 15);
    }
    const rowHtml = pid => {
      const p = P[pid];
      const pts = p.stints.reduce((s, x) => s + x.pts, 0);
      return `<tr class="me-row"><td><b>${pchip(pid)}</b> <small style="color:var(--muted)">${esc(ppos(pid))}</small></td>
        <td class="num">${p.owners}</td>
        <td class="num">${p.events.filter(e => e.t === "trade").length}</td>
        <td class="num">${fmt(pts, 1)}</td>
        <td>${p.owner ? mgrChip(p.owner) : '<span style="color:var(--muted)">free agent</span>'}</td></tr>`;
    };
    return `
      <div class="card"><h2>Player Passports <span class="tag">every player's full league history — click a name</span></h2>
        <div class="controls"><input type="search" id="player-search" placeholder="Search any player…" value="${esc(state.playerQuery || "")}"
          style="background:var(--surface-2);color:var(--ink);border:1px solid var(--border);border-radius:8px;padding:9px 12px;font-size:14px;width:min(340px,100%);font-family:inherit"></div>
        <div class="table-scroll"><table>
        <tr><th>${q.length >= 2 ? "Results" : "Most Traveled"}</th><th class="num">Owners</th><th class="num">Trades</th><th class="num">Career Pts*</th><th>Current Team</th></tr>
        ${rows.map(rowHtml).join("") || '<tr><td colspan="5" style="color:var(--muted)">No players match.</td></tr>'}
        </table></div>
        <p class="footnote">*points scored while in a starting lineup. Player names are clickable all over the site — records, trades, drafts — and open the same passport.</p></div>`;
  }

  function openPassport(pid) {
    const p = (E.passports || {})[pid];
    if (!p) return;
    const evIcon = { draft: "🥇", trade: "🔁", add: "➕", drop: "➖" };
    const evText = e => {
      if (e.t === "draft") return `Drafted ${e.pick} by <b>${esc(nameOf(e.uid))}</b>`;
      if (e.t === "trade") return `Traded to <b>${esc(nameOf(e.uid))}</b>${e.from ? ` by ${esc(nameOf(e.from))}` : ""}`;
      if (e.t === "add") return `${e.kind === "waiver" ? `Claimed off waivers${e.bid ? ` ($${e.bid})` : ""}` : "Signed as a free agent"} by <b>${esc(nameOf(e.uid))}</b>`;
      return `Dropped by <b>${esc(nameOf(e.uid))}</b>`;
    };
    const total = p.stints.reduce((s, x) => s + x.pts, 0);
    showModal(`
      <button class="close" data-close>×</button>
      <h3>${esc(pname(pid))} <small style="color:var(--muted);font-weight:400">${esc(ppos(pid))}</small></h3>
      <p class="note">${p.owner ? `Currently on ${esc(nameOf(p.owner))}'s roster` : "Currently a free agent"} · ${p.owners} franchise${p.owners === 1 ? "" : "s"} · ${fmt(total, 1)} career points started</p>
      <div class="section-title">Journey</div>
      <ul class="watch">${p.events.map(e =>
        `<li><span class="wi">${evIcon[e.t]}</span> ${evText(e)} <small style="color:var(--muted)">· ${e.season}${e.week ? " wk " + e.week : " draft"}</small></li>`).join("") || '<li style="color:var(--muted)">Original startup roster — no moves recorded.</li>'}</ul>
      <div class="section-title">Stints</div>
      <div class="table-scroll"><table>
      <tr><th>Team</th><th>Span</th><th class="num">Weeks</th><th class="num">Pts Started</th></tr>
      ${p.stints.map(s => `<tr><td>${mgrChip(s.uid)}</td><td>${esc(s.from)} → ${esc(s.to)}${p.owner === s.uid && s === p.stints[p.stints.length - 1] ? " (current)" : ""}</td>
        <td class="num">${s.weeks}</td><td class="num">${fmt(s.pts, 1)}</td></tr>`).join("")}
      </table></div>`);
  }

  /* ---------- FRANCHISES ---------- */
  function vFranchise() {
    const active = Object.keys(D.career).filter(u => (E.franchise || {})[u])
      .sort((a, b) => (seatOf[a] || 9) - (seatOf[b] || 9) || nameOf(a).localeCompare(nameOf(b)));
    if (!state.franchiseUid || !active.includes(state.franchiseUid)) {
      state.franchiseUid = active.find(u => D.managers[u].seasons.includes(D.currentSeason)) || active[0];
    }
    const uid = state.franchiseUid;
    const f = E.franchise[uid];
    const posOrder = ["QB", "RB", "WR", "TE", "K", "DEF"];
    const posRank = {};
    posOrder.forEach(p => {
      const vals = active.map(u => (E.franchise[u].pos || {})[p] || 0).sort((x, y) => y - x);
      posRank[p] = vals.indexOf((f.pos || {})[p] || 0) + 1;
    });
    const maxPos = Math.max(...posOrder.map(p => (f.pos || {})[p] || 0), 1);
    const c = D.career[uid];
    const gp = c ? c.w + c.l + c.t : 0;

    return `
      <div class="controls"><label>Franchise</label>
        <select id="franchise-pick">${active.map(u =>
          `<option value="${esc(u)}" ${u === uid ? "selected" : ""}>${esc(nameOf(u))}</option>`).join("")}</select></div>
      <div class="card" style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
        ${avatarHtml(uid, 56)}
        <div>
          <h2 style="margin:0">${esc(teamOf(uid, D.currentSeason))}</h2>
          <p class="note" style="margin:2px 0 0">${esc(nameOf(uid))} · ${c ? `${c.w}-${c.l} all-time` : ""} · ${gp ? fmt(c.pf / gp) : "—"} PPG
          ${c && c.champs.length ? " · " + "🏆".repeat(c.champs.length) + " " + c.champs.join(", ") : ""}</p>
        </div></div>
      <div class="grid cols-2">
        <div class="card"><h2>Franchise Legends <span class="tag">points scored in this team's starting lineup, all-time</span></h2>
          ${recTable(f.legends, [
            { h: "Player", f: r => `<b>${pchip(r.pid)}</b> <small style="color:var(--muted)">${esc(ppos(r.pid))}</small>${r.active ? ' <span class="pill live">ON ROSTER</span>' : ""}` },
            { h: "Points", num: 1, f: r => `<b>${fmt(r.pts, 1)}</b>` },
            { h: "Starts", num: 1, f: r => r.weeks },
          ])}</div>
        <div class="card"><h2>Positional Report Card <span class="tag">career started points · rank of ${active.length}</span></h2>
          <div class="table-scroll"><table>
          ${posOrder.map(p => `<tr class="me-row"><td style="width:44px"><b>${p}</b></td>
            <td><div class="ibar"><div class="track"><div class="fill" style="width:${(((f.pos || {})[p] || 0) / maxPos * 100).toFixed(1)}%;background:${posRank[p] === 1 ? "var(--gold-bright)" : posRank[p] >= active.length - 1 ? "var(--red)" : colorOf(uid)}"></div></div>
            <span class="val">${fmt((f.pos || {})[p] || 0, 0)}</span></div></td>
            <td class="num" style="width:70px;color:${posRank[p] === 1 ? "var(--gold-bright)" : posRank[p] >= active.length - 1 ? "var(--red)" : "var(--muted)"}">${posRank[p] === 1 ? "👑 1st" : ordinal(posRank[p])}</td></tr>`).join("")}
          </table></div>
          <div class="section-title">Best Player-Seasons</div>
          ${recTable(f.bestSeasons, [
            { h: "Player", f: r => `<b>${pchip(r.pid)}</b>` },
            { h: "Season", f: r => r.season },
            { h: "Points", num: 1, f: r => `<b>${fmt(r.pts, 1)}</b>` },
          ])}</div>
      </div><div style="height:18px"></div>
      <div class="grid cols-2">
        <div class="card"><h2>Longest Tenures <span class="tag">this franchise</span></h2>
          ${recTable(f.tenure, [
            { h: "Player", f: r => `<b>${pchip(r.pid)}</b>${r.dayOne ? ' <span class="pill champ">DAY ONE</span>' : r.active ? ' <span class="pill live">ON ROSTER</span>' : ""}` },
            { h: "Weeks", num: 1, f: r => `<b>${r.weeks}</b>` },
          ])}</div>
        <div class="card"><h2>League Tenure Leaders <span class="tag">all franchises</span></h2>
          ${recTable(E.tenureLeaders || [], [
            { h: "Player", f: r => `<b>${pchip(r.pid)}</b>${r.dayOne ? ' <span class="pill champ">DAY ONE</span>' : ""}` },
            { h: "With", f: r => mgrChip(r.uid) },
            { h: "Weeks", num: 1, f: r => `<b>${r.weeks}</b>` },
          ])}</div>
      </div>
      <p class="footnote">“Day One” = drafted in the 2023 startup and still on the same roster today.</p>`;
  }

  /* ---------- AWARDS ---------- */
  function vAwards() {
    const seasons = D.seasons.filter(s => Object.keys((E.weeklyAwards || {})[s] || {}).length);
    const sel = state.awardsSeason && seasons.includes(state.awardsSeason) ? state.awardsSeason : seasons[seasons.length - 1];
    const wa = (E.weeklyAwards || {})[sel] || {};
    const weeks = Object.keys(wa).map(Number).sort((a, b) => a - b);
    return `
      <div class="card"><h2>League Superlatives <span class="tag">computed from every game ever played</span></h2>
        <div class="banner-row" style="margin-top:12px">
        ${(E.superlatives || []).map(s => `<div class="banner superlative">
          <div class="trophy">${s.icon}</div>
          <div class="yr">${esc(s.title)}</div>
          <div class="who">${mgrChip(s.uid, { size: 22 })}</div>
          <div class="team"><b>${esc(s.value)}</b> — ${esc(s.desc)}</div>
        </div>`).join("")}
        </div></div>
      <div class="card"><h2>Weekly Awards Archive</h2>
        <div class="controls"><label>Season</label>
          <select id="awards-season">${seasons.map(s => `<option value="${s}" ${s === sel ? "selected" : ""}>${s}</option>`).join("")}</select></div>
        <div class="table-scroll"><table>
        <tr><th class="num">Wk</th><th>⭐ Player of the Week</th><th class="num">Pts</th><th></th><th>🤡 Bench Blunder</th><th class="num">Pts</th><th></th></tr>
        ${weeks.map(w => {
          const a = wa[String(w)];
          return `<tr class="me-row"><td class="num">${w}</td>
            <td><b>${a.topPid ? pchip(a.topPid) : "—"}</b></td><td class="num">${a.topPts >= 0 ? fmt(a.topPts) : ""}</td>
            <td>${a.topUid ? mgrChip(a.topUid) : ""}</td>
            <td>${a.benchPid ? pchip(a.benchPid) : "—"}</td><td class="num">${a.benchPts >= 0 ? fmt(a.benchPts) : ""}</td>
            <td>${a.benchUid ? mgrChip(a.benchUid) : ""}</td></tr>`;
        }).join("")}
        </table></div></div>`;
  }

  /* ---------- BONEHEADS (lineup efficiency) ---------- */
  function vBench() {
    const L = E.lineup;
    if (!L) return '<div class="card"><p class="note">No lineup data built yet.</p></div>';
    const rows = Object.entries(L.career).sort((a, b) => b[1].eff - a[1].eff);
    const whenF = r => `${r.season} · wk ${r.week}`;
    return `
      <div class="card"><h2>Career Lineup Efficiency <span class="tag">actual points ÷ best possible lineup, every game ever</span></h2>
        <div class="table-scroll"><table>
        <tr><th></th><th>Manager</th><th class="num">Efficiency</th><th style="min-width:150px"></th><th class="num">Left on Bench</th><th class="num">Losses w/ Winning Bench</th></tr>
        ${rows.map(([uid, c], i) => `<tr class="me-row"><td class="rank-cell">${i + 1}</td>
          <td>${mgrChip(uid)}</td>
          <td class="num"><b>${(c.eff * 100).toFixed(1)}%</b></td>
          <td><div class="ibar"><div class="track"><div class="fill" style="width:${((c.eff - 0.6) / 0.4 * 100).toFixed(1)}%;background:${colorOf(uid)}"></div></div></div></td>
          <td class="num">${fmt(c.opt - c.act, 0)} pts</td>
          <td class="num" style="color:${c.lostByBench >= 15 ? "var(--red)" : "inherit"}">${c.lostByBench}</td></tr>`).join("")}
        </table></div>
        <p class="note" style="margin-top:8px">“Losses w/ Winning Bench” = games lost where the optimal lineup would have beaten the opponent's actual score.</p></div>
      <div class="grid cols-2">
        <div class="card"><h2>Worst Start/Sit Weeks Ever</h2>${recTable(L.worstBenchings, [
          { h: "Manager", f: r => mgrChip(r.uid) },
          { h: "Scored", num: 1, f: r => fmt(r.act) },
          { h: "Could Have", num: 1, f: r => fmt(r.opt) },
          { h: "Missed", num: 1, f: r => `<b style="color:var(--red)">${fmt(r.missed)}</b>` },
          { h: "When", f: whenF },
        ])}</div>
        <div class="card"><h2>Games Thrown Away <span class="tag">lost, but the bench had the win</span></h2>${recTable(L.lostByBench, [
          { h: "Manager", f: r => mgrChip(r.uid) },
          { h: "Lost", num: 1, f: r => `${fmt(r.act)}–${fmt(r.oppPts)}` },
          { h: "vs", f: r => esc(nameOf(r.opp)) },
          { h: "Optimal", num: 1, f: r => `<b style="color:var(--good)">${fmt(r.opt)}</b>` },
          { h: "When", f: whenF },
        ])}</div>
      </div>`;
  }

  /* ---------- TRADES & WAIVERS ---------- */
  function vTrades() {
    const trades = E.trades || [];
    const seasons = [...new Set(trades.map(t => t.season))];
    const filt = state.tradeSeason && seasons.includes(state.tradeSeason) ? state.tradeSeason : "all";
    const shown = trades.filter(t => filt === "all" || t.season === filt);

    const tradeCard = t => {
      const verdict = t.verdict
        ? `<span class="pill champ">W: ${esc(nameOf(t.verdict.winner))} +${fmt(t.verdict.margin, 1)}</span>`
        : '<span class="pill" style="color:var(--muted);border:1px solid var(--border)">even / TBD</span>';
      return `<div class="matchup trade">
        ${t.sides.map(s => `<div class="trade-side">
          <div class="ts-head">${mgrChip(s.uid)} <span class="ts-pts">${s.pts ? `+${fmt(s.pts, 1)} pts since` : ""}</span></div>
          <ul>
            ${s.players.map(p => `<li>${pchip(p.pid)} <small>${esc(p.pos)}</small> <span class="ts-val">${fmt(p.pts, 1)}</span></li>`).join("")}
            ${s.picks.map(p => `<li>🎟️ ${p.season} Round ${p.round} pick <small>orig. ${esc(nameOf(p.origUid))}</small></li>`).join("")}
            ${s.faab ? `<li>💵 $${s.faab} FAAB</li>` : ""}
          </ul>
        </div>`).join("")}
        <div class="meta">${t.season} · week ${t.week} ${verdict}</div>
      </div>`;
    };

    const faabRows = Object.entries((E.faab || {}).perSeason || {}).flatMap(([s, m]) =>
      Object.entries(m).map(([uid, amt]) => ({ uid, season: s, amt }))).sort((a, b) => b.amt - a.amt);

    return `
      <div class="grid cols-2">
        <div class="card"><h2>Best Pickups Ever <span class="tag">points scored while rostered after the add</span></h2>
          ${recTable((E.pickups || []).slice(0, 12), [
            { h: "Player", f: r => `<b>${pchip(r.pid)}</b> <small style="color:var(--muted)">${esc(r.pos)}</small>` },
            { h: "Points", num: 1, f: r => `<b>${fmt(r.pts, 1)}</b>` },
            { h: "By", f: r => mgrChip(r.uid) },
            { h: "Cost", num: 1, f: r => r.bid ? `$${r.bid}` : "free" },
            { h: "When", f: r => `${r.season} wk ${r.week}` },
          ])}</div>
        <div class="card"><h2>FAAB Ledger <span class="tag">$${(E.faab || {}).budget || 100} budget</span></h2>
          ${recTable(faabRows.slice(0, 10), [
            { h: "Manager", f: r => mgrChip(r.uid) },
            { h: "Season", f: r => r.season },
            { h: "Spent", num: 1, f: r => `<b>$${r.amt}</b>` },
          ])}
          <div class="section-title">Biggest Bids</div>
          ${recTable((E.faab || {}).topBids || [], [
            { h: "Bid", num: 1, f: r => `<b>$${r.bid}</b>` },
            { h: "Player", f: r => pchip(r.pid) },
            { h: "By", f: r => mgrChip(r.uid) },
            { h: "When", f: r => `${r.season} wk ${r.week}` },
          ])}</div>
      </div>
      <div style="height:18px"></div>
      <div class="card">
        <h2>Trade Log <span class="tag">${trades.length} trades all-time · “pts since” = points scored for the new team after the deal</span></h2>
        <div class="controls"><label>Season</label>
          <select id="trade-season"><option value="all" ${filt === "all" ? "selected" : ""}>All</option>
          ${seasons.map(s => `<option value="${s}" ${s === filt ? "selected" : ""}>${s}</option>`).join("")}</select></div>
        <div class="matchup-grid trades-grid">${shown.map(tradeCard).join("") || '<p class="note">No trades.</p>'}</div>
      </div>`;
  }

  /* ---------- TRADE FINDER ---------- */
  const TF = { pending: false, loaded: false, failed: false, val: {}, model: null };
  function loadTradeValues() {
    if (TF.pending || TF.loaded) return;
    TF.pending = true;
    fetch("https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=1&numTeams=8&ppr=1")
      .then(r => r.json())
      .then(rows => {
        rows.forEach(r => {
          const sid = r.player && r.player.sleeperId;
          if (!sid) return;
          TF.val[sid] = { v: r.value, rv: r.redraftValue || r.value, name: r.player.name, pos: r.player.position,
            age: r.player.maybeAge, team: r.player.maybeTeam || "", posRank: r.positionRank, trend: r.trend30Day || 0 };
        });
        TF.loaded = true; TF.pending = false;
        ensureWyrPairs();
        if (["tradefinder", "preview", "home", "takes"].includes(state.view)) render();
      })
      .catch(() => { TF.failed = true; TF.pending = false; if (state.view === "tradefinder" || state.view === "preview") render(); });
  }

  const TF_POS = ["QB", "RB", "WR", "TE"];
  function tradeModel() {
    if (!LIVE.loaded || !TF.loaded) return null;
    if (TF.model) return TF.model;
    const SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1 }, FLEX = 3;
    const teams = {}, uids = [];
    LIVE.rosters.forEach(r => {
      const uid = r.owner_id; uids.push(uid);
      const players = (r.players || []).map(pid => {
        const fc = TF.val[pid];
        return { pid, pos: fc ? fc.pos : ppos(pid), name: fc ? fc.name : pname(pid),
          v: fc ? fc.v : 0, rv: fc ? fc.rv : 0, age: fc ? fc.age : null, trend: fc ? fc.trend : 0, posRank: fc ? fc.posRank : null };
      }).filter(p => TF_POS.includes(p.pos)).sort((a, b) => b.v - a.v);
      /* starters = best lineup by market value: 1QB 2RB 2WR 1TE + 3 flex */
      const starters = new Set();
      TF_POS.forEach(p => players.filter(x => x.pos === p).slice(0, SLOTS[p]).forEach(x => starters.add(x.pid)));
      players.filter(x => !starters.has(x.pid) && x.pos !== "QB").slice(0, FLEX).forEach(x => starters.add(x.pid));
      const startVal = {}, depthVal = {}, depth = {};
      TF_POS.forEach(p => { startVal[p] = 0; depthVal[p] = 0; depth[p] = []; });
      players.forEach(x => {
        if (starters.has(x.pid)) startVal[x.pos] += x.v;
        else { depthVal[x.pos] += x.v; depth[x.pos].push(x); }
      });
      const total = players.reduce((s, x) => s + x.v, 0);
      teams[uid] = { players, starters, startVal, depthVal, depth, total,
        wAge: total ? players.reduce((s, x) => s + (x.age || 26) * x.v, 0) / total : 26,
        trend: players.reduce((s, x) => s + x.trend, 0) };
    });
    const med = arr => { const s = arr.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const medStart = {}, medDepth = {};
    TF_POS.forEach(p => { medStart[p] = med(uids.map(u => teams[u].startVal[p])); medDepth[p] = med(uids.map(u => teams[u].depthVal[p])); });
    uids.forEach(u => {
      const t = teams[u]; t.need = {}; t.sur = {};
      TF_POS.forEach(p => {
        const th = 0.1 * medStart[p]; // ignore sub-10% edges — everyone is "close to median" somewhere
        const need = medStart[p] - t.startVal[p];
        t.need[p] = need >= th ? need : 0;
        const raw = Math.max(0, t.depthVal[p] - medDepth[p]) + 0.25 * Math.max(0, t.startVal[p] - medStart[p]);
        t.sur[p] = (!t.need[p] && raw >= th) ? raw : 0; // a position can't be both a need and a surplus
      });
      /* tradeable pool: the bench, plus the cheapest starter anywhere the starting group is way above median */
      t.pool = [];
      TF_POS.forEach(p => {
        t.pool.push(...t.depth[p]);
        if (t.startVal[p] > medStart[p] * 1.4) {
          const st = t.players.filter(x => x.pos === p && t.starters.has(x.pid));
          if (st.length) t.pool.push(st[st.length - 1]);
        }
      });
      t.pool.sort((a, b) => b.v - a.v);
      t.bait = t.pool.find(x => t.sur[x.pos] > 0) || t.pool[0] || null;
    });
    const fit = (a, b) => TF_POS.reduce((s, p) => s + Math.min(teams[a].sur[p], teams[b].need[p]), 0);
    const pairs = [];
    for (let i = 0; i < uids.length; i++) for (let j = i + 1; j < uids.length; j++) {
      const a = uids[i], b = uids[j];
      const ageGap = Math.abs(teams[a].wAge - teams[b].wAge);
      pairs.push({ a, b, fitAB: fit(a, b), fitBA: fit(b, a), ageGap,
        comp: fit(a, b) + fit(b, a) + Math.min(1200, Math.max(0, ageGap - 0.7) * 500) });
    }
    const maxComp = Math.max(...pairs.map(p => p.comp), 1);
    pairs.forEach(p => p.score = Math.round(p.comp / maxComp * 100));
    pairs.sort((x, y) => y.comp - x.comp);
    const compOf = {};
    pairs.forEach(p => { (compOf[p.a] = compOf[p.a] || {})[p.b] = p; (compOf[p.b] = compOf[p.b] || {})[p.a] = p; });
    TF.model = { teams, uids, pairs, compOf };
    return TF.model;
  }

  const tfName = p => (E.passports || {})[p.pid] ? `<b>${pchip(p.pid)}</b>` : `<b>${esc(p.name)}</b>`;
  const tfChips = (t, kind) => TF_POS.filter(p => kind === "good" ? t.sur[p] > 0 : t.need[p] > 0)
    .sort((x, y) => kind === "good" ? t.sur[y] - t.sur[x] : t.need[y] - t.need[x])
    .map(p => `<span class="pos-chip ${kind}">${p}</span>`).join("") || '<span style="color:var(--muted)">—</span>';

  /* value-balanced 1-for-1s that address a need on both sides */
  function pairSwaps(a, b, m) {
    const A = m.teams[a], B = m.teams[b], out = [];
    A.pool.forEach(x => {
      if (!(B.need[x.pos] > 0 && A.sur[x.pos] > 0)) return;
      B.pool.forEach(y => {
        if (!(A.need[y.pos] > 0 && B.sur[y.pos] > 0) || y.pos === x.pos) return;
        const hi = Math.max(x.v, y.v), lo = Math.min(x.v, y.v);
        if (!hi || lo / hi < 0.72) return;
        out.push({ x, y, score: lo * (lo / hi) });
      });
    });
    out.sort((p, q) => q.score - p.score);
    const seen = new Set(), top = [];
    out.forEach(s => {
      if (top.length < 3 && !seen.has(s.x.pid) && !seen.has(s.y.pid)) { top.push(s); seen.add(s.x.pid); seen.add(s.y.pid); }
    });
    return top;
  }

  function pairReason(p, m) {
    const A = m.teams[p.a], B = m.teams[p.b];
    const gives = (t, o) => TF_POS.filter(x => t.sur[x] > 0 && o.need[x] > 0);
    const ab = gives(A, B), ba = gives(B, A);
    const bits = [];
    if (ab.length) bits.push(`${nameOf(p.a)} has spare ${ab.join("/")} — exactly what ${nameOf(p.b)} is missing`);
    if (ba.length) bits.push(`${nameOf(p.b)} can send ${ba.join("/")} back`);
    if (p.ageGap >= 1.4) {
      const older = A.wAge > B.wAge ? p.a : p.b, younger = older === p.a ? p.b : p.a;
      bits.push(`timelines diverge — ${nameOf(older)} is win-now, ${nameOf(younger)} is building: vets-for-picks territory`);
    }
    return bits.join(" · ") || "no complementary pieces — these two shop at the same store";
  }

  const pastTrades = (a, b) => (E.trades || []).filter(t =>
    t.sides.length === 2 && t.sides.some(s => s.uid === a) && t.sides.some(s => s.uid === b));

  function vTradeFinder() {
    if (!LIVE.loaded) return '<div class="card"><p class="note">Connecting to Sleeper…</p></div>';
    loadTradeValues();
    if (TF.failed) return '<div class="card"><h2>Trade Finder</h2><p class="note">Couldn’t reach the market-value feed (FantasyCalc). Refresh to retry.</p></div>';
    if (!TF.loaded) return '<div class="card"><h2>Trade Finder</h2><p class="note">Pricing the league — fetching live dynasty market values…</p></div>';
    const m = tradeModel();
    const byVal = m.uids.slice().sort((x, y) => m.teams[y].total - m.teams[x].total);
    const ages = m.uids.map(u => m.teams[u].wAge);
    const aMin = Math.min(...ages), aMax = Math.max(...ages);
    const maxTot = m.teams[byVal[0]].total;

    const board = byVal.map((u, i) => {
      const t = m.teams[u];
      const spec = aMax > aMin ? (t.wAge - aMin) / (aMax - aMin) : 0.5;
      return `<tr class="me-row"><td class="rank-cell">${i + 1}</td><td>${mgrChip(u)}</td>
        <td class="num"><b>${fmt(t.total, 0)}</b></td>
        <td><div class="ibar"><div class="track"><div class="fill" style="width:${(t.total / maxTot * 100).toFixed(1)}%;background:${colorOf(u)}"></div></div></div></td>
        <td><div class="tf-spec"><div class="dot" style="left:calc(${(spec * 100).toFixed(0)}% - 6px)"></div></div><div class="tf-spec-lbl">${spec < 0.35 ? "🌱 building" : spec > 0.65 ? "🏆 win-now" : "⚖️ hybrid"} · avg age ${fmt(t.wAge, 1)}</div></td>
        <td class="num" style="color:${t.trend >= 0 ? "var(--good)" : "var(--red)"}">${t.trend >= 0 ? "▲" : "▼"}${fmt(Math.abs(t.trend), 0)}</td>
        <td>${tfChips(t, "good")}</td><td>${tfChips(t, "bad")}</td>
        <td>${t.bait ? `${tfName(t.bait)} <small style="color:var(--muted)">${esc(t.bait.pos)} · ${fmt(t.bait.v, 0)}</small>` : "—"}</td></tr>`;
    }).join("");

    const mUids = m.uids.slice().sort((x, y) => (seatOf[x] || 9) - (seatOf[y] || 9));
    const cell = (a, b) => {
      if (a === b) return '<td class="self"></td>';
      const p = m.compOf[a][b];
      return `<td style="background:${divergingColor(0.5 + (p.score / 100) * 0.5)}" data-tfpair="${esc(a)}|${esc(b)}">${p.score}</td>`;
    };

    const medals = ["🥇", "🥈", "🥉", "🤝", "🤝"];
    const best = m.pairs.slice(0, 5).map((p, i) => {
      const sw = pairSwaps(p.a, p.b, m)[0];
      return `<li><span class="wi">${medals[i]}</span> <b>${esc(nameOf(p.a))} ↔ ${esc(nameOf(p.b))}</b> <span class="pill live">fit ${p.score}</span><br>
        <span style="color:var(--muted)">${esc(pairReason(p, m))}${sw ? ` · try: ` : ""}</span>${sw ? `${tfName(sw.x)} ⇄ ${tfName(sw.y)}` : ""}</li>`;
    }).join("");

    return `
      <div class="card"><h2>Trade Compatibility <span class="tag">who should be calling whom · click any cell</span></h2>
        <p class="note">Fit = how well one team’s positional surplus lines up with the other’s needs (both directions), plus a bonus when their timelines diverge. 100 = the league’s best match.</p>
        <div class="h2h-wrap"><table class="h2h">
          <tr><th></th>${mUids.map(u => `<th>${esc(nameOf(u))}</th>`).join("")}</tr>
          ${mUids.map(a => `<tr><th>${mgrChip(a)}</th>${mUids.map(b => cell(a, b)).join("")}</tr>`).join("")}
        </table></div></div>
      <div class="card"><h2>Best Fits Right Now <span class="tag">the front-office phone calls to make</span></h2>
        <ul class="watch">${best}</ul></div>
      <div class="card"><h2>League Trade Board <span class="tag">live dynasty market values · surplus, needs &amp; trade bait</span></h2>
        <div class="table-scroll"><table>
        <tr><th></th><th>Manager</th><th class="num">Roster Value</th><th style="min-width:130px"></th><th>Timeline</th><th class="num">30-Day</th><th>Surplus</th><th>Needs</th><th>Top Trade Bait</th></tr>
        ${board}
        </table></div>
        <p class="note" style="margin-top:8px">Surplus/needs compare each team’s best starting lineup and bench depth to the league median at every position. “Trade bait” = the most valuable piece a team can deal from strength.</p></div>
      ${inefficiencyCards(m, aMin, aMax)}
      <p class="footnote">Market values: FantasyCalc dynasty (1QB · 8-team · PPR), refreshed on every page load. Win-Now = FantasyCalc redraft value, same format. 30-Day = roster-wide value trend. K/DEF excluded.</p>`;
  }

  /* win-now (redraft) price vs dynasty price — market inefficiencies on league rosters */
  function inefficiencyCards(m, aMin, aMax) {
    const specOf = u => aMax > aMin ? (m.teams[u].wAge - aMin) / (aMax - aMin) : 0.5;
    const allP = [];
    m.uids.forEach(u => m.teams[u].players.forEach(x => { if (Math.max(x.v, x.rv) >= 1200) allP.push({ ...x, uid: u }); }));
    const vets = allP.filter(p => p.rv > p.v).sort((a, b) => (b.rv - b.v) - (a.rv - a.v)).slice(0, 8);
    const futures = allP.filter(p => p.v > p.rv).sort((a, b) => (b.v - b.rv) - (a.v - a.rv)).slice(0, 8);
    if (!vets.length && !futures.length) return "";
    const table = (rows, kind) => `<div class="table-scroll"><table>
      <tr><th>Player</th><th>Owner</th><th class="num">Dynasty</th><th class="num">Win-Now</th><th class="num">Gap</th><th></th></tr>
      ${rows.map(p => {
        const spec = specOf(p.uid);
        const flag = kind === "vet"
          ? (spec < 0.4 ? '<span class="pill sacko">SHOULD SELL</span>' : "")
          : (spec > 0.6 ? '<span class="pill champ">COULD CASH IN</span>' : "");
        const gap = kind === "vet" ? p.rv - p.v : p.v - p.rv;
        return `<tr class="me-row"><td>${tfName(p)} <small style="color:var(--muted)">${esc(p.pos)}${p.age ? " · " + fmt(p.age, 0) + "y" : ""}</small></td>
          <td>${mgrChip(p.uid)}</td>
          <td class="num">${fmt(p.v, 0)}</td><td class="num">${fmt(p.rv, 0)}</td>
          <td class="num"><b style="color:${kind === "vet" ? "var(--gold-bright)" : "var(--aqua)"}">+${fmt(gap, 0)}</b></td>
          <td>${flag}</td></tr>`;
      }).join("")}</table></div>`;
    return `<div style="height:18px"></div><div class="grid cols-2">
      <div class="card"><h2>Win-Now Bargains <span class="tag">worth more this season than their dynasty price</span></h2>
        <p class="note">Aging producers the market discounts for tomorrow. Contenders should be buying these low — and any rebuilder still holding one is sitting on a depreciating asset.</p>
        ${table(vets, "vet")}</div>
      <div class="card"><h2>Future Premiums <span class="tag">dynasty price far above this-season value</span></h2>
        <p class="note">The youth-and-upside tax. A win-now team can flip these for immediate help at full sticker price — rebuilders pay it gladly.</p>
        ${table(futures, "future")}</div>
    </div>`;
  }

  function openTradePair(a, b) {
    const m = tradeModel(); if (!m) return;
    const p = m.compOf[a][b];
    const swaps = pairSwaps(a, b, m);
    const hist = pastTrades(a, b);
    const side = u => {
      const t = m.teams[u];
      return `<div class="trade-side"><div class="ts-head">${mgrChip(u)}</div>
        <p class="note" style="margin:6px 0">value ${fmt(t.total, 0)} · avg age ${fmt(t.wAge, 1)}</p>
        <div style="margin:4px 0">Can offer ${tfChips(t, "good")}</div>
        <div>Needs ${tfChips(t, "bad")}</div></div>`;
    };
    showModal(`
      <button class="close" data-close>×</button>
      <h3>${esc(nameOf(a))} ↔ ${esc(nameOf(b))} <span class="pill live">fit ${p.score}/100</span></h3>
      <p class="note">${esc(pairReason(p, m))}</p>
      <div class="matchup trade" style="margin-top:10px">${side(a)}${side(b)}</div>
      <div class="section-title">Suggested swaps — value-balanced, both sides improve</div>
      ${swaps.length ? `<ul class="watch">${swaps.map(s =>
        `<li><span class="wi">🔁</span> ${tfName(s.x)} <small style="color:var(--muted)">${esc(s.x.pos)} · ${fmt(s.x.v, 0)}</small> ⇄ ${tfName(s.y)} <small style="color:var(--muted)">${esc(s.y.pos)} · ${fmt(s.y.v, 0)}</small></li>`).join("")}</ul>`
        : '<p class="note">No clean 1-for-1 on the board — this one needs draft picks or a 2-for-1 to balance.</p>'}
      <div class="section-title">Track record</div>
      <p class="note">${hist.length ? `These two have made <b>${hist.length}</b> trade${hist.length > 1 ? "s" : ""} before — the line is warm.` : "These two have never traded. Somebody break the ice."}</p>`);
  }

  /* ---------- playoff odds (Monte Carlo, current season) ---------- */
  function playoffOdds() {
    if (!LIVE.loaded) return null;
    const pweek = D.currentLeague.playoffWeekStart;
    const played = [], future = [];
    for (let w = 1; w < pweek; w++) {
      weekMatchups(D.currentSeason, w).forEach(g => (g.played ? played : future).push(g));
    }
    const wksPlayed = new Set(played.map(g => g.week)).size;
    if (wksPlayed < 3 || !future.length) return null;
    const scores = {};
    played.forEach(g => {
      (scores[g.a.uid] = scores[g.a.uid] || []).push(g.a.pts);
      (scores[g.b.uid] = scores[g.b.uid] || []).push(g.b.pts);
    });
    const stat = {};
    Object.entries(scores).forEach(([u, arr]) => {
      const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
      const sd = Math.sqrt(arr.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, arr.length - 1)) || 18;
      stat[u] = { mean, sd: Math.max(12, sd) };
    });
    const base = {};
    const divOf = {};
    LIVE.rosters.forEach(r => { divOf[r.owner_id] = r.settings.division; });
    currentStandings().forEach(s => { base[s.uid] = { w: s.wins, pf: s.pf }; });
    const uids = Object.keys(base);
    const tally = {}; uids.forEach(u => tally[u] = { po: 0, div: 0, bot2: 0 });
    const N = 2000;
    const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
    for (let i = 0; i < N; i++) {
      const sim = {}; uids.forEach(u => sim[u] = { w: base[u].w, pf: base[u].pf });
      future.forEach(g => {
        const pa = stat[g.a.uid].mean + gauss() * stat[g.a.uid].sd;
        const pb = stat[g.b.uid].mean + gauss() * stat[g.b.uid].sd;
        sim[g.a.uid].pf += pa; sim[g.b.uid].pf += pb;
        if (pa >= pb) sim[g.a.uid].w++; else sim[g.b.uid].w++;
      });
      const rank = uids.slice().sort((a, b) => sim[b].w - sim[a].w || sim[b].pf - sim[a].pf);
      const divWinners = [1, 2].map(d => rank.find(u => divOf[u] === d)).filter(Boolean);
      const wild = rank.filter(u => !divWinners.includes(u)).slice(0, 6 - divWinners.length);
      divWinners.forEach(u => { tally[u].div++; tally[u].po++; });
      wild.forEach(u => tally[u].po++);
      rank.slice(-2).forEach(u => tally[u].bot2++);
    }
    return uids.map(u => ({ uid: u, po: tally[u].po / N, div: tally[u].div / N, bot2: tally[u].bot2 / N }))
      .sort((a, b) => b.po - a.po);
  }

  /* ---------- TROPHY ROOM ---------- */
  function vTrophies() {
    const banners = D.completeSeasons.slice().reverse().map(s => {
      const sd = D.seasonsData[s];
      const pl = (E.plaques || {})[s];
      const plaque = pl ? `<div class="plaque">
        <div class="pl-head">TITLE LINEUP · won ${esc(pl.score)}</div>
        ${pl.lineup.map(x => `<div class="pl-row"><span class="pl-slot">${esc(x.slot)}</span><span>${pchip(x.pid)}</span><span class="pl-pts">${fmt(x.pts)}</span></div>`).join("")}
      </div>` : "";
      return `<div class="banner">
        <div class="yr">${s} CHAMPION</div><div class="trophy">🏆</div>
        <div class="who">${mgrChip(sd.champion, { size: 22 })}</div>
        <div class="team">${esc(teamOf(sd.champion, s))}</div>
        <div class="team" style="margin-top:6px;color:var(--muted)">runner-up: ${esc(nameOf(sd.runnerUp))}</div>
        ${plaque}
      </div>`;
    }).join("");

    const brackets = D.completeSeasons.slice().reverse().map(s => {
      const pg = D.seasonsData[s].playoffGames;
      const game = g => {
        if (!g) return "";
        const win = g.winner;
        const row = t => `<div class="bg-row ${t.uid === win ? "bg-win" : ""}"><span>${esc(nameOf(t.uid))}</span><span>${fmt(t.pts)}</span></div>`;
        return `<div class="bgame">${row(g.a)}${row(g.b)}</div>`;
      };
      const r1 = pg.filter(g => g.type === "playoff" && g.round === 1);
      const semis = pg.filter(g => g.type === "playoff" && g.round === 2);
      const title = pg.find(g => g.type === "championship");
      const third = pg.find(g => g.type === "place-3");
      const fifth = pg.find(g => g.type === "place-5");
      const sacko = pg.find(g => g.type === "sacko");
      return `<div class="card"><h2>${s} Playoff Bracket</h2>
        <div class="bracket">
          <div class="bcol"><div class="bcol-t">Round 1</div>${r1.map(game).join("")}</div>
          <div class="bcol"><div class="bcol-t">Semifinals</div>${semis.map(game).join("")}</div>
          <div class="bcol"><div class="bcol-t">Championship 🏆</div>${game(title)}
            <div class="bcol-t" style="margin-top:14px">3rd Place</div>${game(third)}</div>
          <div class="bcol"><div class="bcol-t">5th Place</div>${game(fifth)}
            <div class="bcol-t" style="margin-top:14px">Shitter Bowl 💩</div>${game(sacko)}</div>
        </div></div>`;
    }).join("");

    const rows = Object.keys(D.career)
      .sort((a, b) => D.career[b].champs.length - D.career[a].champs.length ||
        D.career[b].runnerUps.length - D.career[a].runnerUps.length ||
        D.career[b].playoffApps.length - D.career[a].playoffApps.length)
      .map(uid => {
        const c = D.career[uid];
        return `<tr class="me-row"><td>${mgrChip(uid)}</td>
        <td class="num">${c.champs.length ? "🏆".repeat(c.champs.length) + " " + c.champs.join(", ") : "—"}</td>
        <td class="num">${c.runnerUps.length ? c.runnerUps.join(", ") : "—"}</td>
        <td class="num">${c.playoffApps.length}</td>
        <td class="num">${c.pw}-${c.pl}</td>
        <td class="num">${c.bestFinish ? ordinal(c.bestFinish) : "—"}</td></tr>`;
      }).join("");

    const finishGrid = `<div class="table-scroll"><table>
      <tr><th>Manager</th>${D.completeSeasons.map(s => `<th class="num">${s}</th>`).join("")}</tr>
      ${Object.keys(D.career).sort((a, b) => (seatOf[a] || 9) - (seatOf[b] || 9)).map(uid => {
        const c = D.career[uid];
        return `<tr class="me-row"><td>${mgrChip(uid)}</td>${D.completeSeasons.map(s => {
          const p = c.seasonPlaces[s];
          if (!p) return '<td class="num" style="color:var(--muted)">—</td>';
          const style = p === 1 ? 'color:var(--gold-bright);font-weight:700' : p === 8 ? 'color:var(--red);font-weight:700' : "";
          return `<td class="num" style="${style}">${p === 1 ? "🏆 1st" : ordinal(p)}</td>`;
        }).join("")}</tr>`;
      }).join("")}
    </table></div>`;

    return `<div class="banner-row">${banners}</div><div style="height:18px"></div>
      <div class="card"><h2>Career Hardware</h2>
      <div class="table-scroll"><table>
        <tr><th>Manager</th><th class="num">Titles</th><th class="num">Runner-Up</th><th class="num">Playoff Apps</th><th class="num">Playoff W-L</th><th class="num">Best Finish</th></tr>
        ${rows}</table></div></div>
      <div class="card"><h2>Season Finishes</h2>${finishGrid}</div>
      ${brackets}`;
  }

  /* ---------- SHAME WALL ---------- */
  function vShame() {
    const banners = D.completeSeasons.slice().reverse().map(s => {
      const sd = D.seasonsData[s];
      return `<div class="banner shame">
        <div class="yr">${s} SHITTER</div><div class="trophy">💩</div>
        <div class="who">${mgrChip(sd.sacko, { size: 22 })}</div>
        <div class="team">${esc(teamOf(sd.sacko, s))}</div>
      </div>`;
    }).join("");
    const R = D.records;
    const lowCols = [
      { h: "Manager", f: r => mgrChip(r.uid) },
      { h: "Points", num: 1, f: r => `<b style="color:var(--red)">${fmt(r.pts)}</b>` },
      { h: "vs", f: r => `${esc(nameOf(r.opp))} (${fmt(r.oppPts)})` },
      { h: "When", f: gameCtx },
    ];
    const blowCols = [
      { h: "Victim", f: r => mgrChip(r.lo.uid) },
      { h: "Lost by", num: 1, f: r => `<b style="color:var(--red)">${fmt(r.margin)}</b>` },
      { h: "To", f: r => `${esc(nameOf(r.hi.uid))} (${fmt(r.hi.pts)}–${fmt(r.lo.pts)})` },
      { h: "When", f: gameCtx },
    ];
    const seasonCols = [
      { h: "Manager", f: r => mgrChip(r.uid) },
      { h: "Season", f: r => r.season },
      { h: "Record", num: 1, f: r => `<b style="color:var(--red)">${r.wins}-${r.losses}</b>` },
      { h: "PF", num: 1, f: r => fmt(r.pf, 1) },
      { h: "Finish", f: r => r.place === 8 ? '<span class="pill sacko">SHITTER</span>' : (r.place ? ordinal(r.place) : "—") },
    ];
    const lStreaks = Object.entries(D.streaks).map(([uid, s]) => ({ uid, ...s })).sort((a, b) => b.maxL - a.maxL).slice(0, 5);
    const sackoCount = Object.keys(D.career).filter(u => D.career[u].sackos.length)
      .sort((a, b) => D.career[b].sackos.length - D.career[a].sackos.length);
    return `<div class="banner-row">${banners}</div><div style="height:18px"></div>
      <div class="grid cols-2">
        <div class="card"><h2>Shitter Count</h2><div class="table-scroll"><table>
          <tr><th>Manager</th><th class="num">Shitters</th><th class="num">Years</th></tr>
          ${sackoCount.map(u => `<tr class="me-row"><td>${mgrChip(u)}</td><td class="num">${"💩".repeat(D.career[u].sackos.length)}</td><td class="num">${D.career[u].sackos.join(", ")}</td></tr>`).join("")}
        </table></div></div>
        <div class="card"><h2>Longest Losing Streaks</h2>${recTable(lStreaks, [
          { h: "Manager", f: r => mgrChip(r.uid) },
          { h: "L in a row", num: 1, f: r => `<b style="color:var(--red)">${r.maxL}</b>` },
          { h: "Span", f: r => r.maxLspan ? `${r.maxLspan[0][0]} wk ${r.maxLspan[0][1]} → ${r.maxLspan[1][0]} wk ${r.maxLspan[1][1]}` : "—" },
        ])}</div>
      </div><div style="height:18px"></div>
      <div class="grid cols-2">
        <div class="card"><h2>Worst Single Weeks</h2>${recTable(R.lowScores.slice(0, 10), lowCols)}</div>
        <div class="card"><h2>Worst Blowout Losses</h2>${recTable(R.blowouts, blowCols)}</div>
      </div><div style="height:18px"></div>
      <div class="card"><h2>Worst Seasons</h2>${recTable(R.worstRecords, seasonCols)}</div>`;
  }

  /* ---------- DRAFTS ---------- */
  function vDrafts() {
    const season = state.draftSeason;
    const opts = D.seasons.filter(s => (D.drafts[s] || []).length).map(s =>
      `<option value="${s}" ${s === season ? "selected" : ""}>${s}${s === "2023" ? " (startup)" : ""}</option>`).join("");
    const boards = D.drafts[season] || [];
    const isStartup = season === "2023";
    const hasSeasonPts = D.completeSeasons.includes(season);

    const analysis = hasSeasonPts ? draftAnalysis(season, boards, isStartup) : "";

    const boardHtml = boards.map(b => {
      const perRound = {};
      b.picks.forEach(p => (perRound[p.round] = perRound[p.round] || []).push(p));
      return `<div class="card"><h2>${b.rounds}-Round ${b.type === "snake" ? "Snake" : b.type} Draft <span class="tag">${b.picks.length} picks</span></h2>
        <div class="table-scroll"><table>
        <tr><th class="num">Pick</th><th>Player</th><th>Pos</th><th>Drafted By</th>${hasSeasonPts ? '<th class="num">Pts that season</th><th class="num">Pts since</th>' : ""}</tr>
        ${b.picks.map(p => `<tr class="me-row">
          <td class="num">${p.round}.${String(p.no - (p.round - 1) * 8).padStart(2, "0")}</td>
          <td><b>${esc(p.player)}</b></td><td>${esc(p.pos || "")}</td>
          <td>${mgrChip(p.uid)}${(E.draftVia?.[season] || {})[String(p.no)] ? ` <small style="color:var(--gold-bright)">via ${esc(nameOf(E.draftVia[season][String(p.no)]))}</small>` : ""}</td>
          ${hasSeasonPts ? `<td class="num">${p.ptsSeason != null ? fmt(p.ptsSeason, 1) : "—"}</td><td class="num">${fmt(p.ptsSince, 1)}</td>` : ""}
        </tr>`).join("")}
        </table></div></div>`;
    }).join("");

    const ledger = (E.pickLedger?.[season] || []).filter(r => r.origUid && r.toUid && r.origUid !== r.toUid);
    const ledgerHtml = ledger.length ? `<div class="card"><h2>Traded Pick Ledger <span class="tag">future pick ownership as of the ${season} league</span></h2>
      <div class="table-scroll"><table>
      <tr><th>Pick</th><th>Original Owner</th><th>Now Owned By</th><th>Acquired From</th></tr>
      ${ledger.sort((a, b) => a.pickSeason.localeCompare(b.pickSeason) || a.round - b.round).map(r =>
        `<tr class="me-row"><td><b>${r.pickSeason} Round ${r.round}</b></td>
         <td>${mgrChip(r.origUid)}</td><td>${mgrChip(r.toUid)}</td>
         <td>${r.fromUid && r.fromUid !== r.origUid ? mgrChip(r.fromUid) : '<span style="color:var(--muted)">—</span>'}</td></tr>`).join("")}
      </table></div></div>` : "";

    return `<div class="controls"><label>Draft</label><select id="draft-season">${opts}</select></div>
      ${analysis}${boardHtml}${ledgerHtml}
      <p class="footnote">Player production uses PPR season totals (this league scores skill players at standard PPR). “Pts since” = total points from draft year through ${D.completeSeasons[D.completeSeasons.length - 1]}. Gold “via” tags mark picks acquired by trade.</p>`;
  }

  function draftAnalysis(season, boards, isStartup) {
    const picks = boards.flatMap(b => b.picks).filter(p => p.ptsSeason != null);
    if (picks.length < 8) return "";
    const key = isStartup ? "ptsSeason" : "ptsSince";
    const byVal = picks.slice().sort((a, b) => b[key] - a[key]);
    const valRank = new Map(byVal.map((p, i) => [p.no, i + 1]));
    const scored = picks.map(p => ({ ...p, delta: p.no - valRank.get(p.no) }));
    const steals = scored.filter(p => p.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 8);
    const busts = scored.filter(p => p.delta < 0 && p.no <= picks.length / 2).sort((a, b) => a.delta - b.delta).slice(0, 8);
    const cols = kind => [
      { h: "Player", f: p => `<b>${esc(p.player)}</b> <small style="color:var(--muted)">${esc(p.pos || "")}</small>` },
      { h: "Pick", num: 1, f: p => `#${p.no}` },
      { h: isStartup ? "Pts (season)" : "Pts since", num: 1, f: p => fmt(p[key], 1) },
      { h: "Value rank", num: 1, f: p => `#${valRank.get(p.no)}` },
      { h: "By", f: p => mgrChip(p.uid) },
      { h: kind, num: 1, f: p => `<b style="color:${p.delta > 0 ? "var(--good)" : "var(--red)"}">${p.delta > 0 ? "+" : ""}${p.delta}</b>` },
    ];
    return `<div class="grid cols-2">
      <div class="card"><h2>Biggest Steals</h2><p class="note">Outproduced their draft slot the most (pick # minus production rank).</p>${recTable(steals, cols("Steal"))}</div>
      <div class="card"><h2>Biggest Busts</h2><p class="note">Early picks that fell furthest short.</p>${recTable(busts, cols("Bust"))}</div>
    </div><div style="height:18px"></div>`;
  }

  /* ---------- shared bits ---------- */
  function ordinal(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function seasonPicker() {
    return `<div class="controls"><label>Season</label>
      <select id="season-pick">${D.seasons.slice().reverse().map(s =>
        `<option value="${s}" ${s === state.season ? "selected" : ""}>${s}${s === D.currentSeason ? " (current)" : ""}</option>`).join("")}</select>
      ${state.season === D.currentSeason && LIVE.loaded ? '<span class="pill live">LIVE DATA</span>' : ""}
      ${state.season === D.currentSeason && LIVE.failed ? '<span class="pill" style="color:var(--muted)">offline snapshot</span>' : ""}
    </div>`;
  }

  /* ---------- manager modal ---------- */
  function openManager(uid) {
    const m = M(uid), c = D.career[uid];
    const gp = c ? c.w + c.l + c.t : 0;
    const seasons = m.seasons.slice().sort();
    const finishes = seasons.filter(s => D.completeSeasons.includes(s)).map(s => {
      const st = D.seasonsData[s].standings.find(x => x.uid === uid);
      return `<tr><td>${s}</td><td>${esc(teamOf(uid, s))}</td><td class="num">${st.wins}-${st.losses}</td>
        <td class="num">${fmt(st.pf, 1)}</td>
        <td class="num">${st.place === 1 ? '<span class="pill champ">CHAMP</span>' : st.place === 8 ? '<span class="pill sacko">SHITTER</span>' : ordinal(st.place)}</td></tr>`;
    }).join("");
    const rivals = Object.entries(D.h2h[uid] || {}).map(([o, r]) => ({
      o, w: r.w + r.pw, l: r.l + r.pl, t: r.t, pf: r.pf, pa: r.pa,
    })).sort((a, b) => (b.w / Math.max(1, b.w + b.l)) - (a.w / Math.max(1, a.w + a.l)));
    const st = D.streaks[uid];
    const html = `
      <button class="close" data-close>×</button>
      <h3 style="display:flex;align-items:center;gap:10px">${avatarHtml(uid, 40)} ${esc(m.name)}</h3>
      <p class="note">${esc(teamOf(uid, D.currentSeason))} · in league ${seasons[0]}–${seasons[seasons.length - 1]}</p>
      <div class="tiles" style="grid-template-columns:repeat(auto-fit,minmax(120px,1fr))">
        <div class="tile"><div class="k">Career</div><div class="v" style="font-size:20px">${c ? `${c.w}-${c.l}` : "—"}</div><div class="d">${gp ? pct(c.w / gp) : ""}</div></div>
        <div class="tile"><div class="k">PPG</div><div class="v" style="font-size:20px">${gp ? fmt(c.pf / gp) : "—"}</div><div class="d">${c ? fmt(c.pf, 1) : ""} total</div></div>
        <div class="tile gold"><div class="k">Titles</div><div class="v" style="font-size:20px">${c ? c.champs.length : 0}</div><div class="d">${c && c.champs.length ? c.champs.join(", ") : ""}</div></div>
        <div class="tile red"><div class="k">Shitters</div><div class="v" style="font-size:20px">${c ? c.sackos.length : 0}</div><div class="d">${c && c.sackos.length ? c.sackos.join(", ") : ""}</div></div>
      </div>
      ${st ? `<p class="note">Longest win streak <b style="color:var(--good)">${st.maxW}</b> · longest skid <b style="color:var(--red)">${st.maxL}</b> · playoff record <b>${c.pw}-${c.pl}</b></p>` : ""}
      <div class="section-title">Season by season</div>
      <div class="table-scroll"><table><tr><th>Year</th><th>Team</th><th class="num">Record</th><th class="num">PF</th><th class="num">Finish</th></tr>${finishes}</table></div>
      <div class="section-title">Rivalries</div>
      <div class="table-scroll"><table><tr><th>vs</th><th class="num">Record</th><th class="num">PF</th><th class="num">PA</th></tr>
      ${rivals.map(r => `<tr><td>${mgrChip(r.o)}</td><td class="num"><b>${r.w}-${r.l}${r.t ? "-" + r.t : ""}</b></td><td class="num">${fmt(r.pf, 1)}</td><td class="num">${fmt(r.pa, 1)}</td></tr>`).join("")}
      </table></div>`;
    showModal(html);
  }

  function openH2HLog(a, b) {
    const games = ALL_GAMES.filter(g =>
      (g.a.uid === a && g.b.uid === b) || (g.a.uid === b && g.b.uid === a))
      .sort((g1, g2) => g2.season.localeCompare(g1.season) || g2.week - g1.week);
    const r = (D.h2h[a] || {})[b] || { w: 0, l: 0, t: 0, pw: 0, pl: 0 };
    const rows = games.map(g => {
      const me = g.a.uid === a ? g.a : g.b, them = g.a.uid === a ? g.b : g.a;
      const win = g.type === "regular" ? me.pts > them.pts : g.winner === a;
      const tie = g.type === "regular" && me.pts === them.pts;
      return `<tr><td>${g.season}</td><td class="num">wk ${g.week}</td>
        <td>${tie ? "T" : win ? '<span class="pill win">W</span>' : '<span class="pill loss">L</span>'}</td>
        <td class="num"><b>${fmt(me.pts)}–${fmt(them.pts)}</b></td>
        <td>${g.type !== "regular" ? typeLabel(g.type) : ""}</td></tr>`;
    }).join("");
    showModal(`
      <button class="close" data-close>×</button>
      <h3>${esc(nameOf(a))} vs ${esc(nameOf(b))}</h3>
      <p class="note">All-time: <b>${r.w + r.pw}-${r.l + r.pl}${r.t ? "-" + r.t : ""}</b>${(r.pw || r.pl) ? ` (playoffs ${r.pw}-${r.pl})` : ""} — from ${esc(nameOf(a))}'s side</p>
      <div class="table-scroll"><table><tr><th>Season</th><th class="num">Week</th><th>Res</th><th class="num">Score</th><th>Note</th></tr>${rows}</table></div>`);
  }

  function showModal(inner) {
    closeModal();
    const back = document.createElement("div");
    back.className = "modal-back";
    back.innerHTML = `<div class="modal">${inner}</div>`;
    back.addEventListener("click", e => { if (e.target === back || e.target.closest("[data-close]")) closeModal(); });
    document.body.appendChild(back);
  }
  function closeModal() { $(".modal-back")?.remove(); }

  /* ---------- router / render ---------- */
  function render() {
    const view = VIEWS[state.view] ? state.view : "home";
    const group = groupOf(view);
    document.querySelectorAll("nav.tabs a").forEach(a =>
      a.classList.toggle("active", a.dataset.group === group.label));
    const sub = $("#subnav");
    const subViews = Object.entries(group.views);
    if (subViews.length > 1) {
      sub.innerHTML = subViews.map(([k, label]) =>
        `<a href="#/${k}" class="${k === view ? "on" : ""}">${label}</a>`).join("");
      sub.style.display = "";
    } else {
      sub.innerHTML = "";
      sub.style.display = "none";
    }
    $("#app").innerHTML = VIEWS[view].render();
    if (view === "power") {
      const ps = powerSeries(state.powerSeason);
      if (ps) wireChart("#power-chart", ps, "#power-legend");
    }
    if (view === "elo" && E.elo) {
      wireChart("#elo-chart", { weeks: E.elo.weeks, uids: Object.keys(E.elo.series), series: E.elo.series, sparse: true }, "#elo-legend");
    }
  }

  function nav() {
    const h = (location.hash || "#/home").replace("#/", "");
    if (VIEWS[h]) state.view = h;
    state.weekTouched = false;
    render();
    window.scrollTo(0, 0);
  }

  document.addEventListener("click", e => {
    const pl = e.target.closest("[data-player]");
    if (pl) { openPassport(pl.dataset.player); return; }
    const mgr = e.target.closest("[data-mgr]");
    if (mgr && !e.target.closest(".modal")) { openManager(mgr.dataset.mgr); return; }
    const cell = e.target.closest("[data-h2h]");
    if (cell) { const [a, b] = cell.dataset.h2h.split("|"); openH2HLog(a, b); return; }
    const tfp = e.target.closest("[data-tfpair]");
    if (tfp) { const [a, b] = tfp.dataset.tfpair.split("|"); openTradePair(a, b); return; }
    const rc = e.target.closest("[data-react]");
    if (rc && !rc.disabled) {
      const [w, tu, v] = rc.dataset.react.split("|");
      voteTake("react", w, tu, htMyVote(HT.reacts, Number(w), tu) === v ? null : v);
      return;
    }
    const gr = e.target.closest("[data-grade]");
    if (gr) { const [w, tu, v] = gr.dataset.grade.split("|"); voteTake("grade", w, tu, v); return; }
    if (e.target.id === "ht-open") { openTakeModal(); return; }
    if (e.target.id === "ht-submit") { submitTake(); return; }
    if (e.target.id === "push-enable") { enablePush(); return; }
    if (e.target.id === "push-test") { testPush(); return; }
    if (e.target.id === "push-off") { disablePush(); return; }
    const wy = e.target.closest("[data-wyr]");
    if (wy) {
      const p = wy.dataset.wyr.split("|"); // "week|sidA|sidB|pick"
      wyrVote(p[0], p[1] + "|" + p[2], p[3]);
      return;
    }
    const wk = e.target.closest("[data-week]");
    if (wk) { state.week = +wk.dataset.week; state.weekTouched = true; render(); return; }
    const pick = e.target.closest("[data-pick]");
    if (pick) { pk.sel[pick.dataset.pick] = pick.dataset.team; render(); return; }
    const pm = e.target.closest("[data-pollmove]");
    if (pm) {
      const [u, dir] = pm.dataset.pollmove.split("|");
      const i = pk.poll.indexOf(u);
      const j = dir === "up" ? i - 1 : i + 1;
      if (j >= 0 && j < pk.poll.length) { [pk.poll[i], pk.poll[j]] = [pk.poll[j], pk.poll[i]]; render(); }
      return;
    }
    if (e.target.id === "pk-submit") {
      const games = weekMatchups(D.currentSeason, pk.week).filter(g => g.type === "regular");
      submitPicks(pk.week, games);
      return;
    }
  });
  document.addEventListener("change", e => {
    if (e.target.id === "season-pick") { state.season = e.target.value; state.weekTouched = true; state.week = 1; render(); }
    if (e.target.id === "draft-season") { state.draftSeason = e.target.value; render(); }
    if (e.target.id === "power-season") { state.powerSeason = e.target.value; render(); }
    if (e.target.id === "trade-season") { state.tradeSeason = e.target.value; render(); }
    if (e.target.id === "franchise-pick") { state.franchiseUid = e.target.value; render(); }
    if (e.target.id === "awards-season") { state.awardsSeason = e.target.value; render(); }
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
  document.addEventListener("input", e => {
    if (e.target.id === "player-search") {
      state.playerQuery = e.target.value;
      const pos = e.target.selectionStart;
      render();
      const el = $("#player-search");
      if (el) { el.focus(); el.setSelectionRange(pos, pos); }
    }
  });
  window.addEventListener("hashchange", nav);

  /* boot */
  const tabs = $("nav.tabs");
  tabs.innerHTML = GROUPS.map(g =>
    `<a href="#/${Object.keys(g.views)[0]}" data-group="${g.label}">${g.label}</a>`).join("");
  $("#league-sub").textContent =
    `Dynasty · ${D.seasons.length} seasons · est. ${D.seasons[0]} · updated ${D.generatedAt}`;
  nav();
  loadLive();
  loadTakes();
  loadWyr();
  loadTradeValues(); // market values power the home-page poll + trade tools
})();
