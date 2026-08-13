import { buildPushPayload } from "@block65/webcrypto-web-push";

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
 *   POST /take                   {uid, pin, season, week, text} — hot take, editable until lock
 *   POST /react                  {uid, pin, season, week, takeUid, vote: "fire"|"trash"|null}
 *   POST /grade                  {uid, pin, season, week, takeUid, vote: "wine"|"milk"} — opens 3 weeks after the take
 *   GET  /takes?season=S         all takes + reaction/grade votes + grading cutoff
 *   POST /wyrpairs               {season, week, pairs: [[sid,sid]…]} — seed the week's "who ya rather" pairs (first write wins)
 *   POST /wyrvote                {uid, pin, season, week, pairKey, pick}
 *   GET  /wyr?season=S           stored pairs per week + all votes
 *   POST /push/subscribe         {uid, pin, sub} — register a Web Push subscription for reminders
 *   POST /push/unsubscribe       {uid, pin, endpoint}
 *   POST /push/test              {uid, pin} — send a test notification to your own devices
 *
 * Cron (see wrangler.toml): Wed 6pm CT hot-take/poll reminder, Thu 4pm CT
 * pick'em reminder — each only to subscribed managers who haven't done it.
 */

const ALLOWED_ORIGINS = ["https://lbffl.com", "https://www.lbffl.com",
  "http://localhost:8642", "http://127.0.0.1:8642",
  "http://localhost:8123", "http://127.0.0.1:8123"];

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

async function listAllKeys(env, prefix) {
  const out = [];
  let cursor;
  do {
    const res = await env.PICKS.list({ prefix, cursor });
    out.push(...res.keys);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return out;
}

let stateCache = { v: null, ts: 0 }; // NFL season/week, for grading eligibility
async function nflState() {
  if (stateCache.v && Date.now() - stateCache.ts < 300_000) return stateCache.v;
  try {
    const r = await fetch("https://api.sleeper.app/v1/state/nfl");
    const s = await r.json();
    stateCache = { v: { season: String(s.season), week: Number(s.week) || 0, type: s.season_type || "" }, ts: Date.now() };
  } catch (e) {
    stateCache = { v: { season: null, week: 0, type: "" }, ts: Date.now() };
  }
  return stateCache.v;
}

/* takes from this week are graded 3+ weeks later, once history has ruled */
async function gradeableThroughWeek(env, season) {
  const st = await nflState();
  if (!st.season) return -1;
  if (String(season) < st.season) return 99;
  if (String(season) > st.season) return -1;
  return st.week - 3;
}

function authed(env, b) {
  const pins = JSON.parse(env.PINS || "{}");
  return b && b.uid && pins[b.uid] && String(b.pin) === String(pins[b.uid]);
}

/* ---------------- web push ---------------- */
const vapidOf = env => ({ subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY });
const subId = endpoint => btoa(endpoint).replace(/[^a-zA-Z0-9]/g, "").slice(-24);

async function pushTo(env, uid, data) {
  let sent = 0;
  for (const k of await listAllKeys(env, `push:${uid}:`)) {
    const sub = await env.PICKS.get(k.name, "json");
    if (!sub) continue;
    try {
      const payload = await buildPushPayload(
        { data: JSON.stringify(data), options: { ttl: 6 * 3600, urgency: "normal" } },
        sub, vapidOf(env));
      const res = await fetch(sub.endpoint, payload);
      if (res.status === 404 || res.status === 410) await env.PICKS.delete(k.name); // device gone
      else if (res.ok || res.status === 201) sent++;
    } catch (e) { /* transient failure — keep the subscription for next time */ }
  }
  return sent;
}

async function subscribedUids(env) {
  const uids = new Set();
  for (const k of await listAllKeys(env, "push:")) uids.add(k.name.split(":")[1]);
  return uids;
}

async function runCron(env, cron) {
  const st = await nflState();
  if (!st.season) return;
  const wk = Math.max(1, Math.min(18, st.week || 1));
  const subscribed = await subscribedUids(env);
  if (!subscribed.size) return;

  if (cron.endsWith("* * 3")) { // Wednesday: hot take + who-ya-rather
    if (!["pre", "regular"].includes(st.type)) return;
    const posted = new Set((await listAllKeys(env, `take:${st.season}:${wk}:`)).map(k => k.name.split(":")[3]));
    for (const uid of subscribed) {
      if (posted.has(uid)) continue;
      await pushTo(env, uid, {
        title: "🌶️ Hot Take Wednesday",
        body: `Week ${wk} takes and Who-Ya-Rather polls are open — the league is waiting on yours.`,
        url: "https://lbffl.com/#/takes",
      });
    }
  }

  if (cron.endsWith("* * 4")) { // Thursday: pick'em locks tonight
    if (st.type !== "regular") return;
    if (await weekLocked(env, st.season, wk)) return; // already kicked off
    const submitted = new Set((await listAllKeys(env, `sub:${st.season}:${wk}:`)).map(k => k.name.split(":")[3]));
    for (const uid of subscribed) {
      if (submitted.has(uid)) continue;
      await pushTo(env, uid, {
        title: "🏈 Pick'em locks tonight",
        body: `Week ${wk} picks lock at kickoff and yours aren't in yet.`,
        url: "https://lbffl.com/#/picks",
      });
    }
  }
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

      if (req.method === "POST" && url.pathname === "/take") {
        const b = await req.json();
        if (!authed(env, b)) return new Response(JSON.stringify({ error: "bad pin" }), { status: 403, headers });
        const { uid, season, week } = b;
        const text = String(b.text || "").trim().slice(0, 280);
        if (!season || !week || week < 1 || week > 18) return new Response(JSON.stringify({ error: "bad week" }), { status: 400, headers });
        if (text.length < 3) return new Response(JSON.stringify({ error: "give us an actual take" }), { status: 400, headers });
        if (await weekLocked(env, season, week)) {
          return new Response(JSON.stringify({ error: "week is locked — takes are on the record" }), { status: 409, headers });
        }
        await env.PICKS.put(`take:${season}:${week}:${uid}`,
          JSON.stringify({ uid, season: String(season), week: Number(week), text, ts: Date.now() }));
        return new Response(JSON.stringify({ ok: true }), { headers });
      }

      if (req.method === "POST" && url.pathname === "/react") {
        const b = await req.json();
        if (!authed(env, b)) return new Response(JSON.stringify({ error: "bad pin" }), { status: 403, headers });
        const { uid, season, week, takeUid, vote } = b;
        if (![null, "fire", "trash"].includes(vote)) return new Response(JSON.stringify({ error: "bad vote" }), { status: 400, headers });
        if (takeUid === uid) return new Response(JSON.stringify({ error: "you can't hype your own take" }), { status: 400, headers });
        const take = await env.PICKS.get(`take:${season}:${week}:${takeUid}`);
        if (!take) return new Response(JSON.stringify({ error: "no such take" }), { status: 404, headers });
        const key = `react:${season}:${week}:${takeUid}:${uid}`;
        if (vote === null) await env.PICKS.delete(key);
        else await env.PICKS.put(key, vote);
        return new Response(JSON.stringify({ ok: true }), { headers });
      }

      if (req.method === "POST" && url.pathname === "/grade") {
        const b = await req.json();
        if (!authed(env, b)) return new Response(JSON.stringify({ error: "bad pin" }), { status: 403, headers });
        const { uid, season, week, takeUid, vote } = b;
        if (!["wine", "milk"].includes(vote)) return new Response(JSON.stringify({ error: "bad vote" }), { status: 400, headers });
        const through = await gradeableThroughWeek(env, season);
        if (Number(week) > through) return new Response(JSON.stringify({ error: "not gradeable yet — history needs time" }), { status: 409, headers });
        const take = await env.PICKS.get(`take:${season}:${week}:${takeUid}`);
        if (!take) return new Response(JSON.stringify({ error: "no such take" }), { status: 404, headers });
        await env.PICKS.put(`grade:${season}:${week}:${takeUid}:${uid}`, vote);
        return new Response(JSON.stringify({ ok: true }), { headers });
      }

      if (req.method === "GET" && url.pathname === "/takes") {
        const season = url.searchParams.get("season");
        const takes = [];
        for (const k of await listAllKeys(env, `take:${season}:`)) {
          const v = await env.PICKS.get(k.name, "json");
          if (v) takes.push(v);
        }
        const votes = async prefix => {
          const out = {};
          for (const k of await listAllKeys(env, `${prefix}:${season}:`)) {
            const [, , wk, takeUid, voter] = k.name.split(":");
            const v = await env.PICKS.get(k.name);
            if (v) ((out[`${wk}:${takeUid}`] = out[`${wk}:${takeUid}`] || {})[voter] = v);
          }
          return out;
        };
        const body = {
          takes: takes.sort((a, b) => b.week - a.week || a.ts - b.ts),
          reacts: await votes("react"),
          grades: await votes("grade"),
          gradeableThroughWeek: await gradeableThroughWeek(env, season),
        };
        return new Response(JSON.stringify(body), { headers });
      }

      if (req.method === "POST" && url.pathname === "/wyrpairs") {
        const b = await req.json();
        const { season, week } = b;
        if (!season || !week || week < 1 || week > 18) return new Response(JSON.stringify({ error: "bad week" }), { status: 400, headers });
        const key = `wyrp:${season}:${week}`;
        const existing = await env.PICKS.get(key, "json");
        if (existing) return new Response(JSON.stringify({ pairs: existing }), { headers });
        const pairs = Array.isArray(b.pairs) ? b.pairs.slice(0, 4) : [];
        const ok = pairs.length >= 1 && pairs.every(p =>
          Array.isArray(p) && p.length === 2 && p.every(x => /^\d{1,12}$/.test(String(x))) && p[0] !== p[1]);
        if (!ok) return new Response(JSON.stringify({ error: "bad pairs" }), { status: 400, headers });
        await env.PICKS.put(key, JSON.stringify(pairs));
        return new Response(JSON.stringify({ pairs }), { headers });
      }

      if (req.method === "POST" && url.pathname === "/wyrvote") {
        const b = await req.json();
        if (!authed(env, b)) return new Response(JSON.stringify({ error: "bad pin" }), { status: 403, headers });
        const { uid, season, week, pairKey, pick } = b;
        const stored = await env.PICKS.get(`wyrp:${season}:${week}`, "json");
        const pair = (stored || []).find(p => `${p[0]}|${p[1]}` === pairKey);
        if (!pair) return new Response(JSON.stringify({ error: "no such matchup" }), { status: 404, headers });
        if (!pair.includes(String(pick))) return new Response(JSON.stringify({ error: "pick one of the two" }), { status: 400, headers });
        await env.PICKS.put(`wyrv:${season}:${week}:${pairKey}:${uid}`, String(pick));
        return new Response(JSON.stringify({ ok: true }), { headers });
      }

      if (req.method === "POST" && url.pathname === "/push/subscribe") {
        const b = await req.json();
        if (!authed(env, b)) return new Response(JSON.stringify({ error: "bad pin" }), { status: 403, headers });
        const sub = b.sub;
        if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
          return new Response(JSON.stringify({ error: "bad subscription" }), { status: 400, headers });
        }
        await env.PICKS.put(`push:${b.uid}:${subId(sub.endpoint)}`, JSON.stringify(sub));
        return new Response(JSON.stringify({ ok: true }), { headers });
      }

      if (req.method === "POST" && url.pathname === "/push/unsubscribe") {
        const b = await req.json();
        if (!authed(env, b)) return new Response(JSON.stringify({ error: "bad pin" }), { status: 403, headers });
        if (b.endpoint) await env.PICKS.delete(`push:${b.uid}:${subId(b.endpoint)}`);
        return new Response(JSON.stringify({ ok: true }), { headers });
      }

      if (req.method === "POST" && url.pathname === "/push/test") {
        const b = await req.json();
        if (!authed(env, b)) return new Response(JSON.stringify({ error: "bad pin" }), { status: 403, headers });
        const sent = await pushTo(env, b.uid, {
          title: "🔔 Notifications are on",
          body: "You'll get the Wednesday hot-take nudge and Thursday pick'em alerts right here.",
          url: "https://lbffl.com/",
        });
        return new Response(JSON.stringify({ ok: true, sent }), { headers });
      }

      if (req.method === "GET" && url.pathname === "/wyr") {
        const season = url.searchParams.get("season");
        const pairs = {};
        for (const k of await listAllKeys(env, `wyrp:${season}:`)) {
          const wk = k.name.split(":")[2];
          const v = await env.PICKS.get(k.name, "json");
          if (v) pairs[wk] = v;
        }
        const votes = {};
        for (const k of await listAllKeys(env, `wyrv:${season}:`)) {
          const [, , wk, pairKey, voter] = k.name.split(":");
          const v = await env.PICKS.get(k.name);
          if (v) ((votes[`${wk}:${pairKey}`] = votes[`${wk}:${pairKey}`] || {})[voter] = v);
        }
        return new Response(JSON.stringify({ pairs, votes }), { headers });
      }

      return new Response(JSON.stringify({ error: "not found" }), { status: 404, headers });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env, event.cron));
  },
};
