// Run: node app.test.js
// Smoke test for public/app.js: runs the whole script against a stand-in page (every element
// accepts anything) so a missing variable or a broken render fails here, not on game night.
// Then a substitution from the queue diagram, end to end through the real action.
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');

// An element that takes any property and any method call.
const fake = () => {
  const store = { style: { setProperty() {} }, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, length: 0, [Symbol.toPrimitive]: () => '' };
  return new Proxy(function () {}, {
    get: (t, k) => (k in store ? store[k] : k === Symbol.iterator ? [][Symbol.iterator] : (store[k] = fake())),
    set: (t, k, v) => { store[k] = v; return true; },
    apply: () => fake(),
  });
};
const els = {};
const storage = new Map();
const t0 = Date.now();
const players = [...'ABCDEFGHIJKL'].map((n, i) => ({ name: `Player ${n}`, games: 0, readyAt: t0 - 1000 * (20 - i), present: true, totalPoints: 0 }));
const onCourt = players.slice(0, 10).map((p, i) => ({ name: p.name, team: i < 5 ? 'home' : 'away', points: i === 0 ? 6 : 0 }));
storage.set('pickup-rotation-v1', JSON.stringify({
  players, expected: [], unsynced: [], startedAt: t0,
  // Saved before substitutions existed: no subbedOut list.
  game: { number: 1, onCourt, satOut: [], homeName: 'Home', awayName: 'Away', remainingMs: 600000, endsAt: null, started: true },
}));

const context = vm.createContext({
  console, Proxy, Date, JSON, Math, Map, Set, Promise, Error, String, Number, Boolean, Array, Object, Symbol,
  module: undefined,
  document: {
    getElementById: id => (els[id] ??= fake()),
    querySelector: () => fake(), querySelectorAll: () => [], addEventListener() {},
    activeElement: null, fullscreenElement: null,
  },
  window: { addEventListener() {}, scrollTo() {} },
  localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
  location: { protocol: 'file:', hash: '#queue', search: '' }, // file: keeps the database calls offline
  history: { replaceState() {} },
  navigator: {},
  CSS: { escape: s => s },
  confirm: () => true,
  setInterval() {}, setTimeout() {},
  fetch: () => Promise.reject(new Error('offline')),
});
for (const file of ['public/names.js', 'public/queue.js', 'public/app.js']) {
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
}
const run = code => vm.runInContext(code, context);

// The first render ran with no errors; the diagram marks who can be dragged and where to.
let map = els.qmap.innerHTML;
assert.match(map, /data-seat="Player A"/);
assert.match(map, /draggable="true" tabindex="0" role="button" data-sub="Player K"/);
assert.doesNotMatch(map, /data-sub="Player A"/); // on court: a drop target, not draggable

// Check in: one list, grouped by status (on court, here, to arrive, done), then A to Z, with
// each status's own look and button.
run(`state.expected = ['Player A', 'Zed New', 'Abe New']; player('Player L').present = false; seatOf('Player A').team = 'away'; render();`);
assert.equal(els.rosterCount.innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), '10 on court 1 here 2 to arrive 1 done');
const roster = els.roster.innerHTML;
assert.equal((roster.match(/class="qn/g) || []).length, 14); // Player A appears once, not twice
const order = [...roster.matchAll(/<b>([^<]+)<\/b>/g)].map(m => m[1]);
assert.deepEqual(order.slice(9), ['Player J', 'Player K', 'Abe New', 'Zed New', 'Player L']);
assert.match(roster, /class="qn st-court on away"[^>]*><b>Player A<\/b><small>Away<\/small>/);
assert.deepEqual(order.slice(0, 6), ['Player B', 'Player C', 'Player D', 'Player E', 'Player A', 'Player F']); // Home, then Away
run(`seatOf('Player A').team = 'home';`);
assert.match(roster, /class="qn st-here"[^>]*><b>Player K<\/b><button class="btn o s" data-action="done"/);
assert.match(roster, /class="qn st-arrive"[^>]*><b>Zed New<\/b><button class="btn s" data-action="checkIn"/);
assert.match(roster, /class="qn st-done out"[^>]*><b>Player L<\/b><button class="btn o s" data-action="undoDone"/);
// Done takes a player out of the queue; Undo puts them back.
run(`actions.done('Player K'); commit();`);
assert.ok(!run(`Queue.waitingOrder(state.players, state.game).some(p => p.name === 'Player K')`));
run(`actions.undoDone('Player K'); actions.undoDone('Player L'); commit();`);
assert.equal(run(`Queue.waitingOrder(state.players, state.game).length`), 2);

// Sub K in for A (who has 6 points) mid-game: the score holds, A is waiting again.
run(`if (actions.sub('Player A', 'Player K') !== false) commit();`);
assert.equal(els.homeScore.textContent, 6);
map = els.qmap.innerHTML;
assert.match(map, /data-seat="Player K"/);
assert.match(map, /data-sub="Player A"/);
assert.equal(JSON.parse(storage.get('pickup-rotation-v1')).game.subbedOut[0].name, 'Player A');

// Click, then click: L is picked first, then dropped on B.
run(`subPick = 'Player L'; renderQueue();`);
assert.match(els.qmap.innerHTML, /picked" draggable/);
run(`doSub('Player B', subPick);`);
assert.equal(run('subPick'), null);

// End the game: everyone who played gets a result row, A's 6 points included.
run(`actions.endGame(); commit();`);
const sent = JSON.parse(storage.get('pickup-rotation-v1')).unsynced[0].rows;
assert.equal(sent.length, 12);
assert.equal(sent.find(r => r.name === 'Player A').points, 6);
assert.deepEqual(run('state.game.subbedOut'), []);

console.log('app.test.js: all checks passed');
