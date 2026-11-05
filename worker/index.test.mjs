// Run: node worker/index.test.mjs
// The sign-in gate, end to end through worker.fetch with a fake env: files, an empty
// database and no rate limiter (as in local dev), then a limiter that refuses.
import assert from 'node:assert';
import worker from './index.js';

const PASS = 'court-night-42';
const served = [];
const env = {
  ORGANIZER_PASSCODE: PASS,
  ASSETS: { fetch: async req => { served.push(new URL(req.url).pathname); return new Response('file', { status: 200 }); } },
  DB: { prepare: () => ({ all: async () => ({ results: [] }) }) },
};
const at = (path, init = {}) => worker.fetch(new Request(`https://pickup.test${path}`, init), env);
const post = (path, body, headers = {}) => at(path, {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers },
});

// Signed out: the app and its files send you home with the passcode form open, the API
// refuses, and no file is handed out.
for (const path of ['/app', '/app.html', '/app.js', '/sw.js', '/queue.js']) {
  const res = await at(path);
  assert.equal(res.status, 302, path);
  assert.equal(res.headers.get('Location'), 'https://pickup.test/?signin', path);
}
assert.equal((await at('/api/profiles')).status, 401);
assert.equal((await at('/api/session')).status, 401); // the home page shows the passcode box
assert.equal((await post('/api/players', { names: ['Ana'] }, { Authorization: `Bearer ${PASS}` })).status, 401); // the passcode alone is not a session
assert.deepEqual(served, []);

// The old sign-in address goes to the home page.
for (const path of ['/login', '/login.html']) assert.equal((await at(path)).headers.get('Location'), 'https://pickup.test/', path);

// The home page (it holds the sign-in), the logo and the tab icon are open.
for (const path of ['/', '/index.html', '/logo.png', '/favicon.png']) assert.equal((await at(path)).status, 200, path);
assert.deepEqual(served, ['/', '/index.html', '/logo.png', '/favicon.png']);

// Sign in: a wrong passcode gets nothing; the right one gets a 30-day, script-proof cookie.
assert.equal((await post('/api/login', { passcode: 'guess' })).status, 401);
assert.equal((await post('/api/login', {})).status, 401);
assert.equal((await at('/api/login', { method: 'POST', body: 'passcode=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
const ok = await post('/api/login', { passcode: PASS });
assert.equal(ok.status, 200);
assert.deepEqual(await ok.json(), []);
const setCookie = ok.headers.get('Set-Cookie');
for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) assert.ok(setCookie.includes(part), part);
const session = setCookie.split(';')[0];

// Signed in: pages and data flow; writes still need the passcode as well.
assert.equal((await at('/app', { headers: { Cookie: session } })).status, 200);
for (const path of ['/', '/index.html']) { // a signed-in device skips the sign-in page
  const res = await at(path, { headers: { Cookie: session } });
  assert.equal(res.status, 302, path);
  assert.equal(res.headers.get('Location'), 'https://pickup.test/app', path);
}
assert.equal((await at('/app.js', { headers: { Cookie: session } })).status, 200);
assert.equal((await at('/api/profiles', { headers: { Cookie: session } })).status, 200);
assert.equal((await at('/api/session', { headers: { Cookie: session } })).status, 204); // the home page goes straight to /app
assert.equal((await post('/api/players', { names: ['Ana'] }, { Cookie: session })).status, 401);
const db = [];
env.DB = { prepare: sql => ({ bind: (...v) => ({ sql, v }), all: async () => ({ results: [] }) }), batch: async q => { db.push(...q); } };
assert.equal((await post('/api/players', { names: ['Ana'] }, { Cookie: session, Authorization: `Bearer ${PASS}` })).status, 200);
assert.equal(db.length, 1);
// A finished game: each row's insert names its columns, field goals included.
const game = { session: 1793700000000, date: '2026-11-06', game: 1, rows: [{ name: 'Ana', points: 7, fgm: 3, fga: 8, won: 1 }] };
assert.equal((await post('/api/results', game, { Cookie: session, Authorization: `Bearer ${PASS}` })).status, 200);
const insert = db.find(q => q.sql.includes('INTO results'));
assert.match(insert.sql, /\(session, played_on, game, name, points, fgm, fga, won\)/);
assert.deepEqual(insert.v, [1793700000000, '2026-11-06', 1, 'Ana', 7, 3, 8, 1]);

// A cookie from before a passcode change no longer works.
env.ORGANIZER_PASSCODE = 'new-passcode-7';
assert.equal((await at('/app', { headers: { Cookie: session } })).status, 302);
env.ORGANIZER_PASSCODE = PASS;

// Sign out clears the cookie.
const out = await at('/api/logout', { method: 'POST' });
assert.equal(out.status, 204);
assert.match(out.headers.get('Set-Cookie'), /^session=; .*Max-Age=0/);

// Past the rate limit, sign-in is refused before the passcode is even checked.
env.LOGIN_LIMIT = { limit: async ({ key }) => ({ success: key !== '203.0.113.9' }) };
assert.equal((await post('/api/login', { passcode: PASS }, { 'CF-Connecting-IP': '203.0.113.9' })).status, 429);
assert.equal((await post('/api/login', { passcode: PASS }, { 'CF-Connecting-IP': '198.51.100.4' })).status, 200);

console.log('index.test.mjs: all checks passed');
