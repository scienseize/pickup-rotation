// Cloudflare Worker: organizer sign-in, the app's files and its API on D1.
// Every request reaches this first (run_worker_first): only the home page (with the sign-in),
// the logo, the tab icon and POST /api/login are open. Everything else, the app at /app
// included, needs a valid session cookie.
import { Invalid, isJson, playersBody, gameBody, passcodeOk, signSession, sessionOk, SESSION_DAYS } from './rules.js';

const MAX_BODY = 1_000_000;
const OPEN = new Set(['/', '/index.html', '/logo.png', '/favicon.png']);
const cookie = (value, maxAge) => `session=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

async function profiles(db) {
  const { results } = await db.prepare(`
    SELECT p.name AS name, COUNT(r.points) AS games, COALESCE(SUM(r.points), 0) AS points, AVG(r.points) AS avg
    FROM players p LEFT JOIN results r ON r.name = p.name
    GROUP BY p.name ORDER BY p.name`).all();
  return results.map(p => ({ ...p, avg: p.avg === null ? null : Math.round(p.avg * 10) / 10 }));
}

async function write(db, path, body) {
  const addPlayer = (name, on) => db.prepare('INSERT OR IGNORE INTO players VALUES (?, ?)').bind(name, on);
  if (path === '/api/players') {
    const today = new Date().toISOString().slice(0, 10);
    const names = playersBody(body);
    if (names.length) await db.batch(names.map(n => addPlayer(n, today)));
    return;
  }
  // One transaction per game; a repeat is ignored by UNIQUE (session, game, name).
  const g = gameBody(body);
  if (!g.rows.length) return;
  await db.batch([
    ...g.rows.map(r => addPlayer(r.name, g.date)),
    ...g.rows.map(r => db.prepare('INSERT OR IGNORE INTO results VALUES (?, ?, ?, ?, ?)')
      .bind(g.session, g.date, g.game, r.name, r.points)),
  ]);
}

// The passcode buys a 30-day session cookie. LOGIN_LIMIT (5 tries a minute per address)
// slows guessing; it is absent in local dev.
async function login(request, env, now) {
  if (!isJson(request)) return json(415, { error: 'send JSON' });
  if (Number(request.headers.get('Content-Length')) > MAX_BODY) return json(413, { error: 'request too large' });
  if (env.LOGIN_LIMIT) {
    const { success } = await env.LOGIN_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!success) return json(429, { error: 'too many tries' });
  }
  let body;
  try { body = await request.json(); } catch { return json(400, { error: 'invalid JSON' }); }
  if (typeof body?.passcode !== 'string' || !(await passcodeOk(`Bearer ${body.passcode}`, env.ORGANIZER_PASSCODE))) {
    return json(401, { error: 'wrong passcode' });
  }
  const res = json(200, await profiles(env.DB));
  res.headers.append('Set-Cookie', cookie(await signSession(env.ORGANIZER_PASSCODE, now), SESSION_DAYS * 86400));
  return res;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname, now = Date.now();
    if (request.method === 'GET' && OPEN.has(path)) return env.ASSETS.fetch(request);
    if (path === '/login' || path === '/login.html') return Response.redirect(new URL('/', url).href, 302); // the old sign-in address
    if (request.method === 'POST' && path === '/api/login') return login(request, env, now);
    if (request.method === 'POST' && path === '/api/logout') {
      return new Response(null, { status: 204, headers: { 'Set-Cookie': cookie('', 0), 'Cache-Control': 'no-store' } });
    }
    if (!(await sessionOk(request.headers.get('Cookie'), env.ORGANIZER_PASSCODE, now))) {
      return path.startsWith('/api/') ? json(401, { error: 'sign in' }) : Response.redirect(new URL('/?signin', url).href, 302);
    }
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

    if (request.method === 'GET' && path === '/api/profiles') return json(200, await profiles(env.DB));
    if (request.method !== 'POST' || !['/api/players', '/api/results'].includes(path)) {
      return json(404, { error: 'not found' });
    }
    if (!isJson(request)) return json(415, { error: 'send JSON' });
    if (Number(request.headers.get('Content-Length')) > MAX_BODY) return json(413, { error: 'request too large' });
    if (!(await passcodeOk(request.headers.get('Authorization'), env.ORGANIZER_PASSCODE))) {
      return json(401, { error: 'passcode needed' });
    }
    let body;
    try { body = await request.json(); } catch { return json(400, { error: 'invalid JSON' }); }
    try {
      await write(env.DB, path, body);
    } catch (e) {
      if (e instanceof Invalid) return json(400, { error: e.message });
      throw e;
    }
    return json(200, await profiles(env.DB));
  },
};
