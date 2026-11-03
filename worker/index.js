// Cloudflare Worker: the app's API on D1. Files in public/ are served as static
// assets before this runs, so only requests that aren't a file reach it.
import { Invalid, isJson, playersBody, gameBody, passcodeOk } from './rules.js';

const MAX_BODY = 1_000_000;

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

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
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
