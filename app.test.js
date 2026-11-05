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

// The first render ran with no errors. The Queue tab is the diagram: every box is selectable and
// draggable, and it holds its own Full screen button.
let map = els.qmap.innerHTML;
assert.match(map, /class="qn on home" data-p="Player A" data-src="court" draggable="true"/);
assert.match(map, /class="qn nx (home|away)" data-p="Player K" data-src="next" draggable="true"/); // court full: K is in the next lineup
assert.match(map, /data-action="fullscreen"/);
assert.doesNotMatch(map, /data-action="fill"/); // the court is full
assert.match(map, /data-zone="line"/);

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

// The queue's actions never ask to confirm.
context.confirm = () => { throw new Error('the queue asked to confirm'); };
const zone = z => ({ dataset: { zone: z }, closest: () => null });
const onto = (name, src) => ({ dataset: { p: name, src }, closest: () => null });
const court = () => run(`state.game.onCourt.map(c => c.name).join()`);

// The court is full, so Up next is game 2's lineup in its own Home and Away: K and L (no games
// yet) plus the 8 on court with the fewest games, 5 and 5.
const lineup = () => run(`nextLineup(Date.now()).map(x => x.name + ':' + x.team).join()`);
assert.equal(run(`nextLineup(Date.now()).filter(x => x.team === 'home').length`), 5);
assert.match(lineup(), /Player K:/);
// Select K in the lineup, then click A on court: no pairing (a lineup player isn't waiting).
run(`choose('Player K', 'next')`);
assert.match(els.qmap.innerHTML, /class="qn nx \w+ picked" data-p="Player K" data-src="next"/);
run(`choose('Player K', 'next')`); // clears

// Mid-game sub, by clicks, with M: a late arrival with more games, so only waiting.
run(`state.players.push({ name: 'Player M', games: 3, readyAt: Date.now(), present: true, totalPoints: 0 }); render();`);
assert.match(els.qmap.innerHTML, /data-p="Player M" data-src="wait"/);
run(`choose('Player M', 'wait')`);
map = els.qmap.innerHTML;
assert.match(map, /class="qn picked" data-p="Player M" data-src="wait"[\s\S]*?data-action="done" data-name="Player M"/);
assert.doesNotMatch(map, /data-action="pick"/); // no Pick while the game is on
run(`choose('Player A', 'court')`); // M subs in for A, who has 6 points; the score holds
assert.equal(run('sel'), null);
assert.equal(els.homeScore.textContent, 6);
assert.ok(court().startsWith('Player M,'));
assert.equal(JSON.parse(storage.get('pickup-rotation-v1')).game.subbedOut[0].name, 'Player A');
// A mistaken sub, swapped straight back: A returns with their points; M leaves no trace.
run(`choose('Player A', 'wait'); choose('Player M', 'court');`);
assert.ok(court().startsWith('Player A,'));
assert.deepEqual(run(`state.game.subbedOut`), []);

// Replace someone in the lineup with a waiting player (drag M onto them), and switch a lineup
// player's team by dragging them onto someone on the other team.
const homeNext = run(`nextLineup(Date.now()).find(x => x.team === 'home').name`);
const awayNext = run(`nextLineup(Date.now()).find(x => x.team === 'away').name`);
context.dropOn = run('dropOn');
context.dropOn('Player M', 'wait', onto(homeNext, 'next'));
assert.ok(lineup().includes('Player M:home') && !lineup().includes(homeNext + ':'));
context.dropOn('Player M', 'next', onto(awayNext, 'next'));
assert.ok(lineup().includes('Player M:away') && lineup().includes(awayNext + ':home'));
const planned = lineup();

// End the game: everyone who played gets a result row, A's 6 points included, and Up next takes
// the court in its teams.
context.confirm = () => true;
run(`actions.endGame(); commit();`);
const sent = JSON.parse(storage.get('pickup-rotation-v1')).unsynced[0].rows;
assert.equal(sent.length, 10);
assert.equal(sent.find(r => r.name === 'Player A').points, 6);
assert.equal(run(`state.game.onCourt.map(c => c.name + ':' + c.team).join()`), planned);
assert.doesNotMatch(els.qmap.innerHTML, /data-action="fill"/); // already full

// Game 2, before play: a selected court player has Sit out and Remove, and no team buttons.
context.confirm = () => { throw new Error('the queue asked to confirm'); };
const [first] = run(`state.game.onCourt.map(c => c.name)`);
run(`choose(${JSON.stringify(first)}, 'court')`);
map = els.qmap.innerHTML;
for (const a of ['sitOut', 'remove']) assert.match(map, new RegExp(`data-action="${a}" data-name="${first}"`));
assert.doesNotMatch(map, /data-action="team"/);
// Both teams full: dragging a Home player onto an Away player swaps the two.
const firstTeam = run(`seatOf(${JSON.stringify(first)}).team`);
const rival = run(`state.game.onCourt.find(c => c.team !== ${JSON.stringify(firstTeam)}).name`);
context.dropOn(first, 'court', onto(rival, 'court'));
assert.notEqual(run(`seatOf(${JSON.stringify(first)}).team`), firstTeam);
assert.equal(run(`seatOf(${JSON.stringify(rival)}).team`), firstTeam);
// Back to the line undoes the call; then Fill is back, and onto Away calls them again, on Away.
context.dropOn(first, 'court', zone('line'));
assert.equal(run(`seatOf(${JSON.stringify(first)})`), undefined);
assert.match(els.qmap.innerHTML, /data-action="fill"/);
const awaySide = run(`['home', 'away'].find(t => !teamFull(t))`);
context.dropOn(first, 'wait', zone(awaySide));
assert.equal(run(`seatOf(${JSON.stringify(first)}).team`), awaySide);

console.log('app.test.js: all checks passed');
