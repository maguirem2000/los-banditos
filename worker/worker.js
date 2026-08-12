/**
 * Los Banditos picks & power-poll backend (Cloudflare Worker + KV).
 *
 * Auth: per-manager 4-digit PIN (env PINS = JSON {sleeperUserId: "1234"}).
 * Lock: a week locks once any matchup in it has live points on Sleeper
 *       (i.e. Thursday kickoff). Before lock, nobody can read others' picks.
 *
 * Routes:
 *   POST /submit                 {uid, pin, season, week, picks, poll}
 *   GET  /subs?season=S&week=W   submissions for one week (details only if locked)
 *   GET  /season?season=S        all submissions for locked weeks + submitted flags
 */

const ALLOWED_ORIGINS = ["https://lbffl.com", "https://www.lbffl.com",
  "http://localhost:8642", "http://127.0.0.1:8642"];

function cors(origin) {
  const o = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": o,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

const lockCache = new Map(); // `${season}:${week}` -> {locked, ts}

async function weekLocked(env, season, week) {
  const key = `${season}:${week}`;
  const hit = lockCache.get(key);
  if (hit && (hit.locked || Date.now() - hit.ts < 60_000)) return hit.locked;
  let locked = false;
  try {
    const r = await fetch(`https://api.sleeper.app/v1/league/${env.LEAGUE_ID}/matchups/${week}`);
    const rows = await r.json();
    locked = Array.isArray(rows) && rows.some(m => (m.points || 0) > 0);
  } catch (e) { /* fail open (unlocked) so an API blip can't eat submissions */ }
  lockCache.set(key, { locked, ts: Date.now() });
  return locked;
}

async function listWeek(env, season, week) {
  const out = [];
  const list = await env.PICKS.list({ prefix: `sub:${season}:${week}:` });
  for (const k of list.keys) {
    const v = await env.PICKS.get(k.name, "json");
    if (v) out.push(v);
  }
  return out;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const headers = cors(req.headers.get("Origin") || "");
    if (req.method === "OPTIONS") return new Response(null, { headers });

    try {
      if (req.method === "POST" && url.pathname === "/submit") {
        const b = await req.json();
        const pins = JSON.parse(env.PINS || "{}");
        const { uid, pin, season, week } = b;
        if (!uid || !pins[uid] || String(pin) !== String(pins[uid])) {
          return new Response(JSON.stringify({ error: "bad pin" }), { status: 403, headers });
        }
        if (!season || !week || week < 1 || week > 18) {
          return new Response(JSON.stringify({ error: "bad week" }), { status: 400, headers });
        }
        if (await weekLocked(env, season, week)) {
          return new Response(JSON.stringify({ error: "week is locked — games have started" }), { status: 409, headers });
        }
        const rec = {
          uid, season: String(season), week: Number(week),
          picks: b.picks || {},           // {"uidA|uidB": winnerUid}
          poll: Array.isArray(b.poll) ? b.poll.slice(0, 12) : null,  // ranked uids
          ts: Date.now(),
        };
        await env.PICKS.put(`sub:${season}:${week}:${uid}`, JSON.stringify(rec));
        return new Response(JSON.stringify({ ok: true }), { headers });
      }

      if (req.method === "GET" && url.pathname === "/subs") {
        const season = url.searchParams.get("season"), week = Number(url.searchParams.get("week"));
        const locked = await weekLocked(env, season, week);
        const subs = await listWeek(env, season, week);
        const body = locked
          ? { locked: true, subs }
          : { locked: false, submitted: subs.map(s => s.uid) };
        return new Response(JSON.stringify(body), { headers });
      }

      if (req.method === "GET" && url.pathname === "/season") {
        const season = url.searchParams.get("season");
        const list = await env.PICKS.list({ prefix: `sub:${season}:` });
        const weeks = {};
        for (const k of list.keys) {
          const wk = k.name.split(":")[2];
          (weeks[wk] = weeks[wk] || []).push(k.name);
        }
        const out = {};
        for (const wk of Object.keys(weeks)) {
          const locked = await weekLocked(env, season, Number(wk));
          const subs = [];
          for (const name of weeks[wk]) {
            const v = await env.PICKS.get(name, "json");
            if (!v) continue;
            subs.push(locked ? v : { uid: v.uid, week: v.week });
          }
          out[wk] = { locked, subs };
        }
        return new Response(JSON.stringify(out), { headers });
      }

      return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers });
    }
  },
};
