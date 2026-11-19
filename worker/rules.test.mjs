// Run: node worker/rules.test.mjs
import assert from 'node:assert';
import { Invalid, cleanName, playersBody, gameBody, kindBody, liveBody, isJson, passcodeOk, signSession, sessionOk, SESSION_DAYS,
  weekOf, weekEnds, guestCode, cleanCode, signGuest, guestOk } from './rules.js';

const rejects = (fn, why) => assert.throws(fn, Invalid, why);
const req = type => ({ headers: new Headers(type ? { 'Content-Type': type } : {}) });

// Names: trimmed, inner spaces collapsed, 1 to 60 characters, text only.
assert.equal(cleanName('  Ana   Reyes '), 'Ana Reyes');
for (const bad of ['', '   ', 'x'.repeat(61), 7, null]) rejects(() => cleanName(bad), `name ${bad}`);

// The weekly list must be a list, never a string split into letters.
assert.deepEqual(playersBody({ names: ['Ana', ' ben '] }), ['Ana', 'ben']);
rejects(() => playersBody({ names: 'Ana' }));
rejects(() => playersBody(null));
rejects(() => playersBody({ names: Array(1001).fill('Ana') }));
assert.equal(playersBody({ names: Array(1000).fill('Ana') }).length, 1000);

// A finished game: whole points 0 to 200, rows as objects, a real date.
const ok = { session: 1793700000000, date: '2026-11-04', game: 1, rows: [{ name: 'Ana', points: 10 }] };
// A row from before FG, results and teams were tracked gets 0 of 0, no result and no team.
assert.deepEqual(gameBody(ok), { ...ok, rows: [{ name: 'Ana', points: 10, fgm: 0, fga: 0, won: null, team: null, kind: null }] });
// Field goals: whole numbers, made no more than attempted, attempts at most 200.
const shots = (fgm, fga) => gameBody({ ...ok, rows: [{ name: 'Ana', points: 10, fgm, fga }] }).rows[0];
assert.deepEqual(shots(4, 9), { name: 'Ana', points: 10, fgm: 4, fga: 9, won: null, team: null, kind: null });
assert.deepEqual(shots(0, 3), { name: 'Ana', points: 10, fgm: 0, fga: 3, won: null, team: null, kind: null });
for (const [fgm, fga] of [[5, 4], [-1, 3], [1, -1], [1.5, 3], [1, '3'], [0, 201], [1, undefined]]) {
  rejects(() => shots(fgm, fga), `fgm ${fgm} fga ${fga}`);
}
// won: 1 a win, 0 a loss, null (or missing) a tie; nothing else.
const result = won => gameBody({ ...ok, rows: [{ name: 'Ana', points: 10, won }] }).rows[0].won;
assert.equal(result(1), 1);
assert.equal(result(0), 0);
assert.equal(result(null), null);
for (const won of [2, -1, true, '1', 0.5]) rejects(() => result(won), `won ${won}`);
// team: 0 home, 1 away, null (or missing) unknown; nothing else.
const side = team => gameBody({ ...ok, rows: [{ name: 'Ana', points: 10, team }] }).rows[0].team;
assert.equal(side(0), 0);
assert.equal(side(1), 1);
assert.equal(side(null), null);
assert.equal(side(undefined), null);
for (const team of [2, -1, true, '1', 0.5]) rejects(() => side(team), `team ${team}`);
for (const points of [-1, 201, 2.5, '3', true]) rejects(() => gameBody({ ...ok, rows: [{ name: 'Ana', points }] }), `points ${points}`);
rejects(() => gameBody({ ...ok, rows: { name: 'Ana', points: 1 } }));
rejects(() => gameBody({ ...ok, rows: ['Ana'] }));
rejects(() => gameBody({ ...ok, rows: Array(51).fill({ name: 'Ana', points: 1 }) }));
assert.equal(gameBody({ ...ok, rows: Array.from({ length: 50 }, (_, i) => ({ name: `P${i}`, points: 1 })) }).rows.length, 50);
// One row per player: the same name twice (any case) is refused.
rejects(() => gameBody({ ...ok, rows: [{ name: 'Ana', points: 1 }, { name: 'ana', points: 2 }] }));
// kind: the player's type at the time, optional, as null.
const typed = kind => gameBody({ ...ok, rows: [{ name: 'Ana', points: 10, kind }] }).rows[0].kind;
assert.equal(typed('SHS'), 'SHS');
assert.equal(typed(undefined), null);
for (const bad of ['Staff', 'ug', 1]) rejects(() => typed(bad), `kind ${bad}`);
rejects(() => gameBody({ ...ok, date: '2026-02-31' }));
rejects(() => gameBody({ ...ok, game: 0 }));

// A player's type: one of the four, or null to clear it; nothing else, and a real name.
assert.deepEqual(kindBody({ name: 'Ana', kind: 'UG' }), { name: 'Ana', kind: 'UG' });
assert.deepEqual(kindBody({ name: 'Ana', kind: null }), { name: 'Ana', kind: null });
assert.deepEqual(kindBody({ name: 'Ana' }), { name: 'Ana', kind: null });
for (const kind of ['ug', 'Staff', 1, true, '']) rejects(() => kindBody({ name: 'Ana', kind }), `kind ${kind}`);
rejects(() => kindBody({ kind: 'UG' }));
rejects(() => kindBody(null));

// The shared session: a whole id, a real date, a version from 0, and a state object with a players list.
const live = { id: 1793700000000, date: '2026-11-04', version: 0, state: { players: [], game: { number: 1 } } };
assert.deepEqual(liveBody(live), live);
assert.equal(liveBody({ ...live, version: 7 }).version, 7);
for (const bad of [{ id: 1.5 }, { id: -1 }, { id: '1' }, { date: '2026-02-31' }, { date: undefined }, { version: -1 }, { version: 1.5 }, { version: '0' },
  { state: null }, { state: [] }, { state: 'x' }, { state: {} }, { state: { players: 'Ana' } }]) rejects(() => liveBody({ ...live, ...bad }), JSON.stringify(bad));
rejects(() => liveBody(null));

// JSON only, whatever the charset.
assert.ok(isJson(req('application/json; charset=utf-8')));
assert.ok(!isJson(req('text/plain')));
assert.ok(!isJson(req()));

// Passcode: exact match only; a missing secret or header never passes.
assert.equal(await passcodeOk('Bearer court-night-42', 'court-night-42'), true);
assert.equal(await passcodeOk('Bearer court-night-43', 'court-night-42'), false);
assert.equal(await passcodeOk('court-night-42', 'court-night-42'), false);
assert.equal(await passcodeOk(null, 'court-night-42'), false);
assert.equal(await passcodeOk('Bearer ', ''), false);

// Session cookie: good until it expires; a tampered one, a missing one, or one signed with
// an old passcode or another session secret never passes. SESSION_SECRET and the passcode are both needed.
const t0 = 1_800_000_000_000, day = 864e5, P = 'court-night-42', S = 'session-secret-x';
const token = await signSession(P, t0, S);
const jar = `theme=dark; session=${token}; other=1`;
assert.equal(await sessionOk(jar, P, t0 + day, S), true);
assert.equal(await sessionOk(jar, P, t0 + SESSION_DAYS * day + 1, S), false);
assert.equal(await sessionOk(jar, 'new-passcode-7', t0 + day, S), false);
assert.equal(await sessionOk(jar, P, t0 + day, 'other-secret'), false);
assert.equal(await sessionOk(jar, P, t0 + day), false);
const [exp, sig] = token.split('.');
assert.equal(await sessionOk(`session=${Number(exp) + day}.${sig}`, P, t0, S), false); // a longer expiry, same signature
assert.equal(await sessionOk(`session=${exp}.${sig.slice(0, -2)}AA`, P, t0, S), false);
assert.equal(await sessionOk(`session=${exp}.@@@`, P, t0, S), false);
assert.equal(await sessionOk(`session=${token}.junk`, P, t0, S), false); // exactly two parts
// A cookie signed with the passcode alone (what a captured one used to allow guessing) is rejected.
const weak = await crypto.subtle.importKey('raw', new TextEncoder().encode(P), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
const weakSig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', weak, new TextEncoder().encode(`session:${exp}`))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
assert.equal(await sessionOk(`session=${exp}.${weakSig}`, P, t0, S), false);
for (const bad of [null, '', 'theme=dark', 'session=', 'session=abc.def']) assert.equal(await sessionOk(bad, P, t0, S), false);
assert.equal(await sessionOk(jar, '', t0, S), false);
await assert.rejects(signSession(P, t0, ''));
await assert.rejects(signSession('', t0, S));

// The guest code's week starts Thursday 00:00 in UTC+8 (Wednesday 16:00 UTC) and ends at the next one.
const thu = Date.UTC(2026, 10, 18, 16); // Thu 19 Nov 2026, 00:00 in UTC+8
assert.equal(weekOf(thu), weekOf(thu - 1) + 1);
assert.equal(weekOf(thu + 7 * 864e5 - 1), weekOf(thu));
assert.equal(weekEnds(weekOf(thu)), thu + 7 * 864e5);
// The code: six characters with no look-alikes, the same all week, new each week and with new secrets.
const code = await guestCode('pass', 'secret', weekOf(thu));
assert.match(code, /^[A-HJKMNP-Z2-9]{6}$/);
assert.equal(await guestCode('pass', 'secret', weekOf(thu)), code);
assert.notEqual(await guestCode('pass', 'secret', weekOf(thu) + 1), code);
assert.notEqual(await guestCode('other', 'secret', weekOf(thu)), code);
assert.equal(cleanCode(' ab c-12 '), 'ABC12');
assert.equal(cleanCode(null), '');
// The guest cookie: good for its own week only, and only as signed.
const gc = `guest=${await signGuest('pass', 'secret', weekOf(thu))}`;
assert.equal(await guestOk(gc, 'pass', thu + 1000, 'secret'), true);
assert.equal(await guestOk(`a=1; ${gc}`, 'pass', thu + 1000, 'secret'), true);
assert.equal(await guestOk(gc, 'pass', thu + 7 * 864e5, 'secret'), false); // the next week
assert.equal(await guestOk(gc, 'pass', thu - 1, 'secret'), false); // before it began
assert.equal(await guestOk(gc, 'changed', thu + 1000, 'secret'), false); // the passcode changed
const flip = (str, i) => str.slice(0, i) + (str[i] === 'A' ? 'B' : 'A') + str.slice(i + 1); // a middle character: the last one has padding bits
assert.equal(await guestOk(flip(gc, gc.indexOf('.') + 10), 'pass', thu + 1000, 'secret'), false);
assert.equal(await guestOk('session=1.x', 'pass', thu, 'secret'), false); // an organizer cookie is not a guest one
assert.equal(await guestOk(gc, '', thu + 1000, 'secret'), false);

console.log('rules.test.mjs: all checks passed');
