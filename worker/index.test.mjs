// Run: node worker/index.test.mjs
// The sign-in gate, end to end through worker.fetch with a fake env: files, an empty
// database and no rate limiter (as in local dev), then a limiter that refuses.
import assert from 'node:assert';
import worker from './index.js';
import { guestCode, weekOf, weekEnds } from './rules.js';

const PASS = 'court-night-42';
const served = [];
const env = {
  ORGANIZER_PASSCODE: PASS,
  SESSION_SECRET: 'test-session-secret',
  ASSETS: { fetch: async req => { served.push(new URL(req.url).pathname); return new Response('file', { status: 200 }); } },
  DB: { prepare: () => ({ all: async () => ({ results: [] }) }) },
};
const at = (path, init = {}) => worker.fetch(new Request(`https://pickup.test${path}`, init), env);
const post = (path, body, headers = {}) => at(path, {
  method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', ...headers },
});

// Signed out: the organizer app sends you to the guest view with the sign-in open; the shared session,
// every write and (without this week's guest code) the read-only API refuse. The app's files are open.
for (const path of ['/app', '/app.html']) {
  const res = await at(path);
  assert.equal(res.status, 302, path);
  assert.equal(res.headers.get('Location'), 'https://pickup.test/?signin', path);
}
assert.equal((await at('/api/session')).status, 401); // the guest view: not signed in
assert.equal((await at('/api/live')).status, 401);
for (const path of ['/api/profiles', '/api/sessions', '/api/sessions/1', '/api/tonight', '/api/guest-code']) assert.equal((await at(path)).status, 401, path);
assert.equal((await post('/api/players', { names: ['Ana'] }, { Authorization: `Bearer ${PASS}` })).status, 401); // the passcode alone is not a session
for (const path of ['/api/results', '/api/results/fix', '/api/kind', '/api/live']) assert.equal((await post(path, {}, { Authorization: `Bearer ${PASS}` })).status, 401, path);
assert.deepEqual(served, []);
for (const path of ['/app.js', '/queue.js', '/names.js', '/sw.js', '/theme.js']) assert.equal((await at(path)).status, 200, path);
assert.deepEqual(served, ['/app.js', '/queue.js', '/names.js', '/sw.js', '/theme.js']);
served.length = 0;
assert.equal((await at('/signin.js')).status, 302); // the old sign-in page's script is gone

// The old sign-in address goes to the home page.
for (const path of ['/login', '/login.html']) assert.equal((await at(path)).headers.get('Location'), 'https://pickup.test/', path);

// The home page is the guest view: the app's page, served for / (and the old /index.html). The logo
// and the tab icon are open. Every answer asks search engines not to index it.
for (const path of ['/', '/index.html', '/logo.png', '/favicon.png']) {
  const res = await at(path);
  assert.equal(res.status, 200, path);
  assert.equal(res.headers.get('X-Robots-Tag'), 'noindex', path);
}
assert.deepEqual(served, ['/app', '/app', '/logo.png', '/favicon.png']);
for (const res of [await at('/app'), await at('/api/live'), await at('/api/profiles')]) assert.equal(res.headers.get('X-Robots-Tag'), 'noindex');

// The guest code: this week's buys a guest cookie that lasts until the code changes (Thursday 00:00,
// UTC+8); a wrong one, last week's, or a form post gets nothing. Case and spaces don't matter.
const WEEK = weekOf(Date.now()), CODE = await guestCode(PASS, env.SESSION_SECRET, WEEK);
assert.match(CODE, /^[A-HJKMNP-Z2-9]{6}$/);
assert.notEqual(await guestCode(PASS, env.SESSION_SECRET, WEEK + 1), CODE); // next week's differs
for (const code of ['WRONG1', await guestCode(PASS, env.SESSION_SECRET, WEEK - 1), '', 42]) assert.equal((await post('/api/guest', { code })).status, 401, String(code));
assert.equal((await at('/api/guest', { method: 'POST', body: `code=${CODE}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
const entered = await post('/api/guest', { code: ` ${CODE.slice(0, 3).toLowerCase()} ${CODE.slice(3)} ` });
assert.equal(entered.status, 204);
const guestSet = entered.headers.get('Set-Cookie');
for (const part of ['guest=', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(guestSet.includes(part), part);
const maxAge = Number(guestSet.match(/Max-Age=(\d+)/)[1]);
assert.ok(maxAge > 0 && maxAge <= Math.ceil((weekEnds(WEEK) - Date.now()) / 1000) + 1, String(maxAge)); // over when the code changes
const guest = guestSet.split(';')[0];
// A guest reads; they don't get the organizer app, the shared session, the code itself or any write.
for (const path of ['/api/profiles', '/api/sessions']) assert.equal((await at(path, { headers: { Cookie: guest } })).status, 200, path);
assert.equal((await at('/app', { headers: { Cookie: guest } })).status, 302);
for (const path of ['/api/live', '/api/guest-code', '/api/session']) assert.equal((await at(path, { headers: { Cookie: guest } })).status, 401, path);
for (const path of ['/api/players', '/api/results', '/api/kind', '/api/live']) assert.equal((await post(path, {}, { Cookie: guest, Authorization: `Bearer ${PASS}` })).status, 401, path);
// A forged or tampered guest cookie, or one for another week, reads nothing.
for (const bad of [guest + 'x', `guest=${WEEK - 1}.${guest.split('.')[1]}`, 'guest=abc']) assert.equal((await at('/api/profiles', { headers: { Cookie: bad } })).status, 401, bad);
// Guessing is slowed by its own limit (a gym shares one address, so it is looser than sign-in's).
env.GUEST_LIMIT = { limit: async () => ({ success: false }) };
assert.equal((await post('/api/guest', { code: CODE })).status, 429);
delete env.GUEST_LIMIT;

// Files carry the CSP and nosniff; API answers carry nosniff.
const home = await at('/');
assert.match(home.headers.get('Content-Security-Policy'), /script-src 'self'(;|$)/);
assert.equal(home.headers.get('X-Content-Type-Options'), 'nosniff');
assert.equal(home.headers.get('Referrer-Policy'), 'same-origin');
assert.equal((await at('/api/session')).headers.get('X-Content-Type-Options'), 'nosniff');

// Sign in: a wrong passcode gets nothing; the right one gets a 30-day, script-proof cookie.
assert.equal((await post('/api/login', { passcode: 'guess' })).status, 401);
assert.equal((await post('/api/login', {})).status, 401);
assert.equal((await at('/api/login', { method: 'POST', body: 'passcode=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
env.SESSION_SECRET = ''; // no session secret: no cookie
assert.equal((await post('/api/login', { passcode: PASS })).status, 500);
env.SESSION_SECRET = 'test-session-secret';
const ok = await post('/api/login', { passcode: PASS });
assert.equal(ok.status, 200);
assert.deepEqual(await ok.json(), []);
const setCookie = ok.headers.get('Set-Cookie');
for (const part of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', 'Max-Age=2592000']) assert.ok(setCookie.includes(part), part);
const session = setCookie.split(';')[0];
// Organizers see this week's code on Home, and when it changes.
assert.deepEqual(await (await at('/api/guest-code', { headers: { Cookie: session } })).json(), { code: CODE, until: weekEnds(WEEK) });

// Signed in: pages and data flow; writes still need the passcode as well.
assert.equal((await at('/app', { headers: { Cookie: session } })).status, 200);
for (const path of ['/', '/index.html']) { // a signed-in device skips the guest view
  const res = await at(path, { headers: { Cookie: session } });
  assert.equal(res.status, 302, path);
  assert.equal(res.headers.get('Location'), 'https://pickup.test/app', path);
}
assert.equal((await at('/app.js', { headers: { Cookie: session } })).status, 200);
assert.equal((await at('/api/profiles', { headers: { Cookie: session } })).status, 200);
assert.equal((await at('/api/session', { headers: { Cookie: session } })).status, 204); // the home page goes straight to /app
assert.equal((await post('/api/players', { names: ['Ana'] }, { Cookie: session })).status, 401);
const db = [];
// A small stand-in for D1: statements are recorded, and the sessions and results queries run against
// an in-memory table, matched by their SQL.
const sessions = new Map(), saved = [];
const sql = {
  'UPDATE sessions': ([state, played_on, at, id, version]) => {
    const row = sessions.get(id), ok = row?.version === version;
    if (ok) Object.assign(row, { state, played_on, version: version + 1, updated_at: at });
    return { meta: { changes: ok ? 1 : 0 } };
  },
  'INSERT OR IGNORE INTO sessions': ([id, played_on, state, updated_at]) => {
    const fresh = !sessions.has(id);
    if (fresh) sessions.set(id, { id, played_on, version: 1, state, updated_at });
    return { meta: { changes: fresh ? 1 : 0 } };
  },
  'ORDER BY id DESC LIMIT 1': () => [...sessions.values()].sort((a, b) => b.id - a.id)[0],
  'FROM sessions WHERE id = ?': ([id]) => sessions.get(id),
  'FROM results GROUP BY session': () => [...Map.groupBy(saved, r => r.session)].map(([id, rows]) => ({
    id, date: rows[0].played_on, players: new Set(rows.map(r => r.name)).size, games: new Set(rows.map(r => r.game)).size })),
  'FROM sessions': () => [...sessions.values()].map(r => { const st = JSON.parse(r.state); return { id: r.id, date: r.played_on, players: st.players.length, games: st.game.number - 1 }; }),
  'FROM results WHERE session = ?': ([id]) => saved.filter(r => r.session === id)
    .sort((a, b) => a.game - b.game || (a.team ?? -1) - (b.team ?? -1) || b.points - a.points || a.name.localeCompare(b.name))
    .map(({ session, ...columns }) => columns), // the query names its columns
};
const answer = (text, v) => { const key = Object.keys(sql).find(k => text.includes(k)); return key ? sql[key](v) : undefined; };
env.DB = {
  prepare: text => {
    const bound = (...v) => ({ sql: text, v, all: async () => ({ results: answer(text, v) ?? [] }), first: async () => answer(text, v) ?? null, run: async () => answer(text, v) });
    return { ...bound(), bind: bound };
  },
  batch: async q => {
    db.push(...q);
    for (const { sql: t, v } of q) {
      if (t.includes('DELETE FROM results')) saved.splice(0, Infinity, ...saved.filter(r => !(r.session === v[0] && r.game === v[1])));
      if (t.includes('INTO results')) saved.push({ session: v[0], played_on: v[1], game: v[2], name: v[3], points: v[4], fgm: v[5], fga: v[6], won: v[7], team: v[8], kind: v[9] });
    }
  },
};
assert.equal((await post('/api/players', { names: ['Ana'] }, { Cookie: session, Authorization: `Bearer ${PASS}` })).status, 200);
assert.equal(db.length, 1);
// A finished game: each row's insert names its columns, field goals included.
const game = { session: 1793700000000, date: '2026-11-06', game: 1, rows: [{ name: 'Ana', points: 7, fgm: 3, fga: 8, won: 1 }] };
assert.equal((await post('/api/results', game, { Cookie: session, Authorization: `Bearer ${PASS}` })).status, 200);
const insert = db.find(q => q.sql.includes('INTO results'));
assert.match(insert.sql, /\(session, played_on, game, name, points, fgm, fga, won, team, kind\)/);
assert.deepEqual(insert.v, [1793700000000, '2026-11-06', 1, 'Ana', 7, 3, 8, 1, null, null]); // no team or type sent: NULL

// A player's type: passcode and session both needed; adds the player if new, then updates them.
assert.equal((await post('/api/kind', { name: 'Ana', kind: 'UG' }, { Cookie: session })).status, 401);
assert.equal((await post('/api/kind', { name: 'Ana', kind: 'Staff' }, { Cookie: session, Authorization: `Bearer ${PASS}` })).status, 400);
db.length = 0;
assert.equal((await post('/api/kind', { name: 'Ana', kind: 'UG' }, { Cookie: session, Authorization: `Bearer ${PASS}` })).status, 200);
assert.match(db[0].sql, /INSERT OR IGNORE INTO players \(name, added_on\)/);
assert.match(db[1].sql, /UPDATE players SET kind = \? WHERE name = \?/);
assert.deepEqual(db[1].v, ['UG', 'Ana']);

// Over-long lists are refused; a body over the limit is refused even with no Content-Length (a stream).
const auth = { Cookie: session, Authorization: `Bearer ${PASS}` };
assert.equal((await post('/api/players', { names: Array(1001).fill('Ana') }, auth)).status, 400);
assert.equal((await post('/api/results', { ...game, rows: Array(51).fill(game.rows[0]) }, auth)).status, 400);
const chunk = new TextEncoder().encode(' '.repeat(100_000));
const big = await at('/api/players', { method: 'POST', body: new ReadableStream({ start(c) { for (let i = 0; i < 11; i++) c.enqueue(chunk); c.close(); } }), duplex: 'half', headers: { 'Content-Type': 'application/json', ...auth } });
assert.equal(big.status, 413);
assert.equal((await at('/api/players', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'Content-Length': '2000000', ...auth } })).status, 413);
assert.equal((await at('/api/players', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json', ...auth } })).status, 400);

// The shared session. Both calls need the cookie; the push needs the passcode too.
const org = { Cookie: session, Authorization: `Bearer ${PASS}` };
const SID = 1793800000000;
const poll = (id, v) => at(`/api/live?id=${id}&v=${v}`, { headers: { Cookie: session } });
const push = (version, state = {}, id = SID) => post('/api/live', { id, date: '2026-11-06', version, state: { players: [{ name: 'Ana' }], game: { number: 1 }, ...state } }, org);
assert.equal((await poll(0, 0)).status, 204); // no session yet
assert.equal((await at('/api/tonight', { headers: { Cookie: guest } })).status, 204); // and nothing for guests either
assert.equal((await post('/api/live', { id: SID, date: '2026-11-06', version: 0, state: { players: [] } }, { Cookie: session })).status, 401);
assert.equal((await post('/api/live', { id: SID, date: '2026-11-06', version: 0, state: { players: 'Ana' } }, org)).status, 400);
// A new id is created at version 1; a push built on the current version bumps it.
let res = await push(0);
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { version: 1 });
assert.equal((await poll(SID, 1)).status, 204); // unchanged
res = await push(1, { game: { number: 2 } });
assert.deepEqual(await res.json(), { version: 2 });
// Anyone holding another version gets the session; so does a laptop that holds another session.
for (const [id, v] of [[SID, 1], [SID, 0], [1, 2]]) {
  res = await poll(id, v);
  assert.equal(res.status, 200, `${id} v${v}`);
  assert.deepEqual(await res.json(), { id: SID, date: '2026-11-06', version: 2, state: { players: [{ name: 'Ana' }], game: { number: 2 } } });
}
// A push built on an old version is refused with the current copy, and changes nothing.
res = await push(1, { game: { number: 9 } });
assert.equal(res.status, 409);
assert.deepEqual(await res.json(), { id: SID, date: '2026-11-06', version: 2, state: { players: [{ name: 'Ana' }], game: { number: 2 } } });
res = await push(0); // two laptops creating the same session: the second is told, not an error
assert.equal(res.status, 409);
assert.equal((await res.json()).version, 2);
// The newest id is the current session.
assert.deepEqual(await (await push(0, { game: { number: 1 } }, SID + 1)).json(), { version: 1 });
res = await poll(SID, 2);
assert.equal(res.status, 200);
assert.equal((await res.json()).id, SID + 1);

// History: nights from the sessions table and nights that exist only as results, newest first.
const OLD = 1790000000000;
const night = (session, date, rows) => post('/api/results', { session, date, game: 1, rows }, org);
assert.equal((await night(SID, '2026-11-06', [{ name: 'Ana', points: 7, fgm: 3, fga: 8, won: 1, team: 0 }, { name: 'Ben', points: 2, fgm: 1, fga: 4, won: 0, team: 1 }])).status, 200);
assert.equal(db.findLast(q => q.sql.includes('INTO results')).v.at(-2), 1); // team stored
assert.equal((await night(OLD, '2026-10-30', [{ name: 'Cy', points: 4 }])).status, 200);
const get = path => at(path, { headers: { Cookie: session } });
assert.deepEqual(await (await get('/api/sessions')).json(), [
  { id: SID + 1, date: '2026-11-06', players: 1, games: 0 },
  { id: SID, date: '2026-11-06', players: 1, games: 1 },
  { id: 1793700000000, date: '2026-11-06', players: 1, games: 1 }, // the game saved above, in no stored session
  { id: OLD, date: '2026-10-30', players: 1, games: 1 },
]);
// Participants come from the stored session; box scores from results, with the team when it is known.
assert.deepEqual(await (await get(`/api/sessions/${SID}`)).json(), { id: SID, date: '2026-11-06', participants: ['Ana'], games: [{ game: 1, rows: [
  { name: 'Ana', points: 7, fgm: 3, fga: 8, won: 1, team: 0, kind: null }, { name: 'Ben', points: 2, fgm: 1, fga: 4, won: 0, team: 1, kind: null }] }] });
// A night from before sessions were stored: players are those who played, and no team.
assert.deepEqual(await (await get(`/api/sessions/${OLD}`)).json(), { id: OLD, date: '2026-10-30', participants: ['Cy'], games: [{ game: 1, rows: [
  { name: 'Cy', points: 4, fgm: 0, fga: 0, won: null, team: null, kind: null }] }] });
// An accepted push also corrects the date: a session made with a non-Thursday date fixes itself.
res = await post('/api/live', { id: SID + 1, date: '2026-11-12', version: 1, state: { players: [{ name: 'Ana' }], game: { number: 1 } } }, org);
assert.deepEqual(await res.json(), { version: 2 });
assert.equal((await (await get('/api/sessions')).json())[0].date, '2026-11-12');
assert.equal((await get('/api/sessions/12345')).status, 404);
for (const bad of ['abc', '1;DROP', '-1', '1.5']) assert.equal((await get(`/api/sessions/${bad}`)).status, 400, bad);

// Guests with this week's code read history and tonight. Tonight is the newest session's players only, as
// plain values: who is expected, the game and the laptops' ids stay private, and a number pushed as
// markup comes back as 0; a player with no usable name is left out.
assert.equal((await at(`/api/sessions/${SID}`, { headers: { Cookie: guest } })).status, 200);
assert.equal((await at(`/api/sessions/${SID}`)).status, 401); // no code, no history
res = await post('/api/live', { id: SID + 1, date: '2026-11-12', version: 2, state: {
  players: [{ name: 'Ana', games: 2, totalPoints: '<b>x</b>', fgm: 3.7, fga: -4, wins: 1, losses: 0, present: true, turns: 2, readyAt: 9 }, { name: '' }, { games: 1 }],
  expected: ['Secret Sam'], game: { number: 3, onCourt: [{ name: 'Ana' }] }, seen: { abc: 4 } } }, org);
assert.equal(res.status, 200);
assert.equal((await at('/api/tonight')).status, 401);
res = await at('/api/tonight', { headers: { Cookie: guest } });
assert.equal(res.status, 200);
assert.deepEqual(await res.json(), { date: '2026-11-12', players: [{ name: 'Ana', games: 2, totalPoints: 0, fgm: 3, fga: 0, wins: 1, losses: 0, present: true }] });

// Fixing a finished game (History's Edit): passcode needed; the game's rows are replaced in one
// batch, each with its type, and no rows deletes the game. Other games are left alone.
const fix = { session: SID, date: '2026-11-06', game: 1, rows: [{ name: 'Ana', points: 5, fgm: 2, fga: 8, won: 1, team: 0, kind: 'SHS' }, { name: 'Dee', points: 4, fgm: 2, fga: 4, won: 0, team: 1 }] };
assert.equal((await post('/api/results/fix', fix, { Cookie: session })).status, 401);
assert.equal((await post('/api/results/fix', { ...fix, rows: [fix.rows[0], fix.rows[0]] }, org)).status, 400);
db.length = 0;
assert.equal((await post('/api/results/fix', fix, org)).status, 200);
assert.match(db[0].sql, /DELETE FROM results WHERE session = \? AND game = \?/);
assert.deepEqual(db[0].v, [SID, 1]);
assert.deepEqual((await (await get(`/api/sessions/${SID}`)).json()).games, [{ game: 1, rows: [
  { name: 'Ana', points: 5, fgm: 2, fga: 8, won: 1, team: 0, kind: 'SHS' }, { name: 'Dee', points: 4, fgm: 2, fga: 4, won: 0, team: 1, kind: null }] }]);
assert.equal((await post('/api/results/fix', { ...fix, rows: [] }, org)).status, 200);
assert.equal((await get(`/api/sessions/${SID}`)).status, 200); // the session is still stored
assert.deepEqual((await (await get(`/api/sessions/${SID}`)).json()).games, []);
assert.equal(saved.filter(r => r.session === OLD).length, 1);

// A cookie from before a passcode change no longer works.
env.ORGANIZER_PASSCODE = 'new-passcode-7';
assert.equal((await at('/app', { headers: { Cookie: session } })).status, 302);
env.ORGANIZER_PASSCODE = PASS;

// Sign out clears the cookie, but not for a cross-site request.
assert.equal((await at('/api/logout', { method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
assert.equal((await at('/api/logout', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-site' } })).status, 403);
assert.equal((await at('/api/logout', { method: 'POST', headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 204);
const out = await at('/api/logout', { method: 'POST' });
assert.equal(out.status, 204);
assert.match(out.headers.get('Set-Cookie'), /^session=; .*Max-Age=0/);

// Past the rate limit, sign-in is refused before the passcode is even checked.
env.LOGIN_LIMIT = { limit: async ({ key }) => ({ success: key !== '203.0.113.9' }) };
assert.equal((await post('/api/login', { passcode: PASS }, { 'CF-Connecting-IP': '203.0.113.9' })).status, 429);
assert.equal((await post('/api/login', { passcode: PASS }, { 'CF-Connecting-IP': '198.51.100.4' })).status, 200);

console.log('index.test.mjs: all checks passed');
