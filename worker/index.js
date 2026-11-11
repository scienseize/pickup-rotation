// Cloudflare Worker: organizer sign-in, the app's files and its API on D1.
// Every request reaches this first (run_worker_first): only the home page (with the sign-in),
// the logo, the tab icon, the sign-in page's scripts and POST /api/login are open. Everything else,
// the app at /app included, needs a valid session cookie.
import { Invalid, isJson, playersBody, gameBody, kindBody, passcodeOk, signSession, sessionOk, SESSION_DAYS } from './rules.js';

const MAX_BODY = 1_000_000;
const OPEN = new Set(['/', '/index.html', '/logo.png', '/favicon.png', '/theme.js', '/signin.js']);
const cookie = (value, maxAge) => `session=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;

const json = (status, body) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});

// The app's files get a CSP: scripts only from this origin (no inline), no framing, the fonts from Google.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
async function asset(request, env) {
  const res = await env.ASSETS.fetch(request);
  const out = new Response(res.body, res);
  out.headers.set('X-Content-Type-Options', 'nosniff');
  out.headers.set('Referrer-Policy', 'same-origin');
  out.headers.set('Content-Security-Policy', CSP);
  return out;
}

// A JSON body of at most MAX_BODY bytes, counted as it streams in (Content-Length can be absent or a lie).
// Returns [errorResponse] or [null, body].
async function readJson(request) {
  const len = request.headers.get('Content-Length');
  const tooBig = () => [json(413, { error: 'request too large' })];
  if (len !== null && !(/^\d+$/.test(len) && Number(len) <= MAX_BODY)) return tooBig();
  const chunks = [];
  let size = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      if ((size += r.value.length) > MAX_BODY) { reader.cancel().catch(() => {}); return tooBig(); }
      chunks.push(r.value);
    }
  }
  try { return [null, JSON.parse(await new Blob(chunks).text())]; } catch { return [json(400, { error: 'invalid JSON' })]; }
}

async function profiles(db) {
  const { results } = await db.prepare(`
    SELECT p.name AS name, p.kind AS kind, COUNT(r.points) AS games, COALESCE(SUM(r.points), 0) AS points, AVG(r.points) AS avg,
      COALESCE(SUM(r.fgm), 0) AS fgm, COALESCE(SUM(r.fga), 0) AS fga,
      COALESCE(SUM(r.won = 1), 0) AS wins, COALESCE(SUM(r.won = 0), 0) AS losses
    FROM players p LEFT JOIN results r ON r.name = p.name
    GROUP BY p.name ORDER BY p.name`).all();
  return results.map(p => ({ ...p, avg: p.avg === null ? null : Math.round(p.avg * 10) / 10 }));
}

async function write(db, path, body) {
  const addPlayer = (name, on) => db.prepare('INSERT OR IGNORE INTO players (name, added_on) VALUES (?, ?)').bind(name, on);
  if (path === '/api/kind') { // a player's type; adds the player first if the database doesn't have them yet
    const { name, kind } = kindBody(body);
    await db.batch([addPlayer(name, new Date().toISOString().slice(0, 10)),
      db.prepare('UPDATE players SET kind = ? WHERE name = ?').bind(kind, name)]);
    return;
  }
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
    ...g.rows.map(r => db.prepare('INSERT OR IGNORE INTO results (session, played_on, game, name, points, fgm, fga, won) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(g.session, g.date, g.game, r.name, r.points, r.fgm, r.fga, r.won)),
  ]);
}

// The passcode buys a 30-day session cookie. LOGIN_LIMIT (5 tries a minute per address)
// slows guessing; it is absent in local dev.
async function login(request, env, now) {
  if (!isJson(request)) return json(415, { error: 'send JSON' });
  if (env.LOGIN_LIMIT) {
    const { success } = await env.LOGIN_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'unknown' });
    if (!success) return json(429, { error: 'too many tries' });
  }
  const [err, body] = await readJson(request);
  if (err) return err;
  if (typeof body?.passcode !== 'string' || !(await passcodeOk(`Bearer ${body.passcode}`, env.ORGANIZER_PASSCODE))) {
    return json(401, { error: 'wrong passcode' });
  }
  if (!env.SESSION_SECRET) return json(500, { error: 'sign-in is not set up' });
  const res = json(200, await profiles(env.DB));
  res.headers.append('Set-Cookie', cookie(await signSession(env.ORGANIZER_PASSCODE, now, env.SESSION_SECRET), SESSION_DAYS * 86400));
  return res;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname, now = Date.now();
    const signedIn = () => sessionOk(request.headers.get('Cookie'), env.ORGANIZER_PASSCODE, now, env.SESSION_SECRET);
    // A signed-in device skips the sign-in page and opens the app's Home tab.
    if (request.method === 'GET' && (path === '/' || path === '/index.html') && await signedIn()) {
      return Response.redirect(new URL('/app', url).href, 302);
    }
    if (request.method === 'GET' && OPEN.has(path)) return asset(request, env);
    if (path === '/login' || path === '/login.html') return Response.redirect(new URL('/', url).href, 302); // the old sign-in address
    if (request.method === 'POST' && path === '/api/login') return login(request, env, now);
    if (request.method === 'POST' && path === '/api/logout') {
      const site = request.headers.get('Sec-Fetch-Site'); // a cross-site page can't sign you out
      if (site && site !== 'same-origin' && site !== 'none') return json(403, { error: 'forbidden' });
      return new Response(null, { status: 204, headers: { 'Set-Cookie': cookie('', 0), 'Cache-Control': 'no-store' } });
    }
    if (!(await signedIn())) {
      return path.startsWith('/api/') ? json(401, { error: 'sign in' }) : Response.redirect(new URL('/?signin', url).href, 302);
    }
    if (!path.startsWith('/api/')) return asset(request, env);
    if (request.method === 'GET' && path === '/api/session') return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }); // the home page asks: signed in?

    if (request.method === 'GET' && path === '/api/profiles') return json(200, await profiles(env.DB));
    if (request.method !== 'POST' || !['/api/players', '/api/results', '/api/kind'].includes(path)) {
      return json(404, { error: 'not found' });
    }
    if (!isJson(request)) return json(415, { error: 'send JSON' });
    if (!(await passcodeOk(request.headers.get('Authorization'), env.ORGANIZER_PASSCODE))) {
      return json(401, { error: 'passcode needed' });
    }
    const [err, body] = await readJson(request);
    if (err) return err;
    try {
      await write(env.DB, path, body);
    } catch (e) {
      if (e instanceof Invalid) return json(400, { error: e.message });
      throw e;
    }
    return json(200, await profiles(env.DB));
  },
};
