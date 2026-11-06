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

// Check in: grouped lists, one per status (Home, Away, Here, To arrive, Done), each with a header
// and count; rows sorted with numbers in order; each row its one button.
run(`state.expected = ['Player A', 'Zed New', 'Abe New']; player('Player L').present = false; seatOf('Player A').team = 'away'; render();`);
const roster = els.roster.innerHTML;
const heads = [...roster.matchAll(/<p class="sech">(?:<[^>]+>)*(?:<\/i>)?([^<]+)<span>(\d+)<\/span>/g)].map(m => `${m[1]} ${m[2]}`);
assert.deepEqual(heads, ['Home 4', 'Away 6', 'Here 1', 'To arrive 2', 'Done for the night 1']);
assert.equal((roster.match(/class="rrow"/g) || []).length, 14); // Player A appears once, not twice
const section = k => { const i = roster.indexOf(`s-${k}"`), j = roster.indexOf('<div class="sec ', i); return roster.slice(i, j < 0 ? undefined : j); };
assert.match(section('away'), /class="kt unset"[\s\S]*?Type<\/button><b>Player A<\/b><small>0g<\/small><\/div>/); // on court: details only
assert.match(section('here'), /<b>Player K<\/b><small>0g<\/small><button class="btn o s" data-action="done"/);
assert.match(section('arrive'), /<b>Abe New<\/b><button class="btn s" data-action="checkIn"[\s\S]*<b>Zed New<\/b>/); // A to Z
assert.match(section('done'), /<b>Player L<\/b><small>0g<\/small><button class="btn o s" data-action="undoDone"/);
run(`seatOf('Player A').team = 'home';`);
assert.equal(run(`byName('Test 2', 'Test 10')`) < 0, true); // numbers sort in order
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

// A substitute can come straight from the lineup, by drag or by click: K (in Up next) onto C,
// then back. K scored nothing, so swapping back leaves no trace.
run(`dropOn('Player K', 'next', { dataset: { p: 'Player C', src: 'court' }, closest: () => null })`);
assert.ok(court().includes('Player K') && !court().includes('Player C'));
run(`choose('Player C', 'next'); choose('Player K', 'court');`);
assert.ok(court().includes('Player C') && !court().includes('Player K'));
assert.deepEqual(run(`state.game.subbedOut`), []);
// Someone in the lineup who is already on court can't sub in for a teammate.
const both = run(`nextLineup(Date.now()).map(x => x.name).find(n => seatOf(n))`);
const before2 = court();
run(`choose(${JSON.stringify(both)}, 'next'); choose('Player J', 'court');`);
assert.equal(court(), before2);
run(`sel = null;`);

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

// Scoring in field goals: Miss, +2, +3, Undo (no +1 or -1). B misses, makes a 2 and a 3, then
// undoes the 3: points, shots and the team score agree at every step.
let board = els.homePlayers.innerHTML;
assert.match(board, /data-action="miss" data-name="Player B"[^>]*>Miss</);
assert.match(board, /data-action="make" data-name="Player B" data-arg="2"[^>]*>\+2</);
assert.match(board, /data-action="make" data-name="Player B" data-arg="3"[^>]*>\+3</);
assert.match(board, /data-action="undo" data-name="Player B" data-arg="" disabled>Undo</); // nothing to undo yet
assert.doesNotMatch(board, /\+1<|&minus;1|data-action="points"/);
assert.equal(run(`actions.undo('Player B')`), false);
const b = () => run(`(c => [c.points, c.fgm, c.fga].join())(seatOf('Player B'))`);
run(`actions.miss('Player B'); commit();`);
assert.equal(b(), '0,0,1');
run(`actions.make('Player B', '2'); commit();`);
assert.equal(b(), '2,1,2');
run(`actions.make('Player B', '3'); commit();`);
assert.equal(b(), '5,2,3');
assert.equal(els.homeScore.textContent, 11); // A's 6 and B's 5
assert.match(els.homePlayers.innerHTML, /<b>Player B<\/b><small class="mono">FG 2\/3<\/small>/);
run(`actions.undo('Player B'); commit();`);
assert.equal(b(), '2,1,2');
assert.equal(els.homeScore.textContent, 8);
assert.equal(run(`actions.make('Player B', '1')`), false); // only 2s and 3s

// End the game: everyone who played gets a result row, A's 6 points included, and Up next takes
// the court in its teams.
context.confirm = () => true;
run(`actions.endGame(); commit();`);
const sent = JSON.parse(storage.get('pickup-rotation-v1')).unsynced[0].rows;
assert.equal(sent.length, 10);
assert.equal(sent.find(r => r.name === 'Player A').points, 6);
// Home (A's 6, B's 2) beat Away (nothing): Home's rows say won 1, Away's won 0.
assert.deepEqual(sent.find(r => r.name === 'Player B'), { name: 'Player B', points: 2, fgm: 1, fga: 2, won: 1 });
assert.deepEqual(sent.find(r => r.name === 'Player A'), { name: 'Player A', points: 6, fgm: 0, fga: 0, won: 1 });
assert.equal(sent.find(r => r.name === 'Player F').won, 0);
assert.equal(run(`[player('Player A').wins, player('Player A').losses, player('Player F').wins, player('Player F').losses].join()`), '1,0,0,1');
// The leaderboard shows tonight's FG%: B made 1 of 2; A took no shots, so A's cell is blank.
const lbHtml = els.leaderBoard.innerHTML;
assert.match(lbHtml, /<th class="r" title="Field goals made \/ attempted tonight">FG%<\/th>/);
// B made 1 of 2: under MIN_FG_SHOTS attempts, so the FG% is greyed out and says why on hover.
assert.match(lbHtml, /Player B<\/b>[\s\S]*?<td class="r mono fg few" title="1 of 2 tonight, under 5 attempts"><small>1\/2<\/small> 50%<\/td>/);
assert.match(lbHtml, /Player A<\/b>[\s\S]*?<td class="r mono fg"><\/td>\s*<td class="r mono">1-0<\/td>/); // W-L tonight
assert.match(lbHtml, /Player F<\/b>[\s\S]*?<td class="r mono">0-1<\/td>/);
assert.match(lbHtml, />W-L<\/th>/);
assert.doesNotMatch(lbHtml, />PPG<\/th>|>Win%<\/th>/); // all-time numbers have their own view now
// The toggle is Tonight / All-time (no Per game).
assert.match(els.leaderMode.innerHTML, /data-arg="tonight" aria-pressed="true">Tonight<[\s\S]*data-arg="alltime" aria-pressed="false">All-time</);
assert.doesNotMatch(els.leaderMode.innerHTML, /perGame/);

// All-time: everyone in the database with a game, ranked by points per game with at least
// MIN_ALLTIME_GAMES games; fewer are listed after, unranked. Columns: PPG, Points, FG%, W-L, Win%.
run(`actions.leaderMode('', 'alltime')`);
assert.match(els.leaderBoard.innerHTML, /need the database/); // nothing loaded yet in this test
run(`profiles = new Map([
  ['ana', { name: 'Ana', games: 4, points: 40, avg: 10, fgm: 15, fga: 30, wins: 3, losses: 1 }],
  ['ben', { name: 'Ben', games: 3, points: 36, avg: 12, fgm: 2, fga: 4, wins: 0, losses: 0 }],
  ['cy', { name: 'Cy', games: 1, points: 20, avg: 20, fgm: 0, fga: 0, wins: 1, losses: 0 }],
  ['dee', { name: 'Dee', games: 0, points: 0, avg: null, fgm: 0, fga: 0, wins: 0, losses: 0 }],
]); renderLeaders();`);
const allHtml = els.leaderBoard.innerHTML;
const allRows = [...allHtml.matchAll(/<td class="n">(\d*)<\/td><td class="who"><div><b title="([^"]+)"/g)].map(m => `${m[1] || '-'}${m[2]}`);
assert.deepEqual(allRows, ['1Ben', '2Ana', '-Cy']); // Cy has 1 game: listed, not ranked; Dee never played
assert.match(allHtml, /Ana<\/b>[\s\S]*?<\/button><\/div><\/td><td class="r mono gm">4<\/td><td class="r pts">10\.0<\/td><td class="r mono sub">40<\/td><td class="r mono fg" title="15 of 30 every week"><small>15\/30<\/small> 50%<\/td><td class="r mono sub">3-1<\/td><td class="r mono">75%<\/td>/);
assert.match(allHtml, /Ben<\/b>[\s\S]*?<td class="r mono fg few"/); // 2 of 4: too few attempts
for (const h of ['PPG', 'Points', 'FG%', 'W-L', 'Win%']) assert.match(allHtml, new RegExp(`>${h}</th>`));
// Types work for anyone in the database, not just tonight's players: mark Ana from All-time.
assert.match(allHtml, /data-action="pickKind" data-name="Ana"/);
run(`actions.pickKind('Ana')`);
assert.match(els.leaderBoard.innerHTML, /class="kpick"[\s\S]*data-action="setKind" data-name="Ana" data-arg="Alumni"/);
run(`actions.setKind('Ana', 'Alumni'); commit();`);
assert.equal(run('kindPick'), null);
assert.equal(run(`kindOf('Ana')`), 'Alumni');
assert.match(els.leaderBoard.innerHTML, /Ana<\/b><button[^>]*class="kt k-alumni"[\s\S]*?Alum<\/button>/);
// It waits in state.kinds until the database confirms it (offline here), and is saved.
assert.deepEqual(JSON.parse(storage.get('pickup-rotation-v1')).kinds, [{ name: 'Ana', kind: 'Alumni' }]);
// A second tap replaces the first; clearing it is a null.
run(`actions.setKind('Ana', 'UG'); actions.setKind('Ana', ''); commit();`);
assert.deepEqual(run(`state.kinds`), [{ name: 'Ana', kind: null }]);
assert.equal(run(`kindOf('Ana')`), null);
// The filter ranks from 1 within a type and leaves everyone else out.
run(`actions.setKind('Ana', 'UG'); actions.setKind('Cy', 'SHS'); commit(); actions.leaderKind('', 'UG');`);
const ugRows = [...els.leaderBoard.innerHTML.matchAll(/<td class="n">(\d*)<\/td><td class="who"><div><b title="([^"]+)"/g)].map(m => `${m[1] || '-'}${m[2]}`);
assert.deepEqual(ugRows, ['1Ana']);
assert.match(els.leaderKinds.innerHTML, /data-arg="UG" aria-pressed="true">UG</);
run(`actions.leaderKind('', 'Alumni');`);
assert.match(els.leaderBoard.innerHTML, /No Alumni players here yet/);
run(`actions.leaderKind('', 'all'); actions.leaderMode('', 'tonight');`);
// The app says Visitor everywhere; only the stored value stays Outsider.
assert.match(els.leaderKinds.innerHTML, /data-arg="Outsider"[^>]*>Visitor</);
assert.doesNotMatch(els.leaderKinds.innerHTML, />Outsider</);
run(`actions.pickKind('Ana')`);
assert.match(run(`kindPicker('Ana')`), /data-arg="Outsider"[^>]*>Visitor</);
run(`actions.pickKind('Ana')`);
// A type shows on every screen for someone playing: Check in, leaderboard, diagram, scoreboard.
const onCourt1 = run(`state.game.onCourt[0].name`);
run(`actions.setKind(${JSON.stringify(onCourt1)}, 'Outsider'); commit();`);
assert.match(els.roster.innerHTML, new RegExp(`class="kt k-outsider"[^>]*>?[\\s\\S]{0,200}?Vis</button><b>${onCourt1}</b>`));
assert.match(els.leaderBoard.innerHTML, new RegExp(`${onCourt1}</b><span class="kt k-outsider" title="Visitor">Vis</span>`));
assert.match(els.qmap.innerHTML, new RegExp(`data-p="${onCourt1}" data-src="court"[^]*?<span class="qsub"><span class="kt k-outsider" title="Visitor">Vis</span><small>`));
assert.match(els.homePlayers.innerHTML + els.awayPlayers.innerHTML, new RegExp(`<b>${onCourt1}</b><span class="kt k-outsider" title="Visitor">Vis</span><small class="mono">`));
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

// Switch sides: the board mirrors, saved across a refresh; the teams' scores don't move.
const score = () => [els.homeScore.textContent, els.awayScore.textContent].join();
const before = score();
run(`actions.flip(); commit();`);
assert.equal(JSON.parse(storage.get('pickup-rotation-v1')).flipped, true);
assert.equal(score(), before);
run(`actions.flip(); commit();`);
assert.equal(JSON.parse(storage.get('pickup-rotation-v1')).flipped, false);

// Pending types survive a new session.
context.confirm = () => true;
const pendingBefore = run(`state.kinds.length`);
run(`actions.newSession(); render();`);
assert.equal(run(`state.kinds.length`), pendingBefore);

console.log('app.test.js: all checks passed');
