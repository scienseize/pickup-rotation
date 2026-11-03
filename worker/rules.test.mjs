// Run: node worker/rules.test.mjs
import assert from 'node:assert';
import { Invalid, cleanName, playersBody, gameBody, isJson, passcodeOk } from './rules.js';

const rejects = (fn, why) => assert.throws(fn, Invalid, why);
const req = type => ({ headers: new Headers(type ? { 'Content-Type': type } : {}) });

// Names: trimmed, inner spaces collapsed, 1 to 60 characters, text only.
assert.equal(cleanName('  Ana   Reyes '), 'Ana Reyes');
for (const bad of ['', '   ', 'x'.repeat(61), 7, null]) rejects(() => cleanName(bad), `name ${bad}`);

// The weekly list must be a list, never a string split into letters.
assert.deepEqual(playersBody({ names: ['Ana', ' ben '] }), ['Ana', 'ben']);
rejects(() => playersBody({ names: 'Ana' }));
rejects(() => playersBody(null));

// A finished game: whole points 0 to 200, rows as objects, a real date.
const ok = { session: 1793700000000, date: '2026-11-04', game: 1, rows: [{ name: 'Ana', points: 10 }] };
assert.deepEqual(gameBody(ok), ok);
for (const points of [-1, 201, 2.5, '3', true]) rejects(() => gameBody({ ...ok, rows: [{ name: 'Ana', points }] }), `points ${points}`);
rejects(() => gameBody({ ...ok, rows: { name: 'Ana', points: 1 } }));
rejects(() => gameBody({ ...ok, rows: ['Ana'] }));
rejects(() => gameBody({ ...ok, date: '2026-02-31' }));
rejects(() => gameBody({ ...ok, game: 0 }));

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

console.log('rules.test.mjs: all checks passed');
