// Run: node worker/rules.test.mjs
import assert from 'node:assert';
import { Invalid, cleanName, playersBody, gameBody, kindBody, isJson, passcodeOk, signSession, sessionOk, SESSION_DAYS } from './rules.js';

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
// A row from before FG and results were tracked gets 0 of 0 and no result.
assert.deepEqual(gameBody(ok), { ...ok, rows: [{ name: 'Ana', points: 10, fgm: 0, fga: 0, won: null }] });
// Field goals: whole numbers, made no more than attempted, attempts at most 200.
const shots = (fgm, fga) => gameBody({ ...ok, rows: [{ name: 'Ana', points: 10, fgm, fga }] }).rows[0];
assert.deepEqual(shots(4, 9), { name: 'Ana', points: 10, fgm: 4, fga: 9, won: null });
assert.deepEqual(shots(0, 3), { name: 'Ana', points: 10, fgm: 0, fga: 3, won: null });
for (const [fgm, fga] of [[5, 4], [-1, 3], [1, -1], [1.5, 3], [1, '3'], [0, 201], [1, undefined]]) {
  rejects(() => shots(fgm, fga), `fgm ${fgm} fga ${fga}`);
}
// won: 1 a win, 0 a loss, null (or missing) a tie; nothing else.
const result = won => gameBody({ ...ok, rows: [{ name: 'Ana', points: 10, won }] }).rows[0].won;
assert.equal(result(1), 1);
assert.equal(result(0), 0);
assert.equal(result(null), null);
for (const won of [2, -1, true, '1', 0.5]) rejects(() => result(won), `won ${won}`);
for (const points of [-1, 201, 2.5, '3', true]) rejects(() => gameBody({ ...ok, rows: [{ name: 'Ana', points }] }), `points ${points}`);
rejects(() => gameBody({ ...ok, rows: { name: 'Ana', points: 1 } }));
rejects(() => gameBody({ ...ok, rows: ['Ana'] }));
rejects(() => gameBody({ ...ok, rows: Array(51).fill({ name: 'Ana', points: 1 }) }));
assert.equal(gameBody({ ...ok, rows: Array(50).fill({ name: 'Ana', points: 1 }) }).rows.length, 50);
rejects(() => gameBody({ ...ok, date: '2026-02-31' }));
rejects(() => gameBody({ ...ok, game: 0 }));

// A player's type: one of the four, or null to clear it; nothing else, and a real name.
assert.deepEqual(kindBody({ name: 'Ana', kind: 'UG' }), { name: 'Ana', kind: 'UG' });
assert.deepEqual(kindBody({ name: 'Ana', kind: null }), { name: 'Ana', kind: null });
assert.deepEqual(kindBody({ name: 'Ana' }), { name: 'Ana', kind: null });
for (const kind of ['ug', 'Staff', 1, true, '']) rejects(() => kindBody({ name: 'Ana', kind }), `kind ${kind}`);
rejects(() => kindBody({ kind: 'UG' }));
rejects(() => kindBody(null));

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

console.log('rules.test.mjs: all checks passed');
