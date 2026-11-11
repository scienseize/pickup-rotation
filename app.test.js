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
// The History list: keep its listeners so the test can open a session the way a click would.
const histListeners = [];
els.historyList = fake();
els.historyList.addEventListener = (type, fn) => histListeners.push([type, fn]);
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
    documentElement: { dataset: { theme: 'dark' } },
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
assert.doesNotMatch(map, /\d+ min/); // no wait times: they don't affect the order
assert.match(map, /data-zone="line"/);

// Check in: a board of numbered columns (On court with Home and Away, Here, To arrive with Done at
// its foot), each with a count; rows sorted with numbers in order; each row its one button.
run(`state.expected = ['Player A', 'Zed New', 'Abe New']; player('Player L').present = false; seatOf('Player A').team = 'away'; render();`);
const roster = els.roster.innerHTML;
const panels = [...roster.matchAll(/<span class="kn">(0\d)\.<\/span><h3>([^<]+)<\/h3><span class="kc">(\d+)<\/span>/g)].map(m => `${m[1]} ${m[2]} ${m[3]}`);
assert.deepEqual(panels, ['01 On court 10', '02 Here 1', '03 To arrive 2']);
const subs = [...roster.matchAll(/<p class="sech">(?:<[^>]+><\/i>)?([^<]+)<span>(\d+)<\/span>/g)].map(m => `${m[1]} ${m[2]}`);
assert.deepEqual(subs, ['Home 4', 'Away 6', 'Done for the night 1']);
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
// M, now in the edited lineup, subs onto the court: M gives up the Up next spot (they've played
// this game), and the next in fair order fills it, keeping 5 and 5. Then swap back.
context.dropOn('Player M', 'next', onto('Player D', 'court'));
assert.ok(court().includes('Player M') && !lineup().includes('Player M:'));
assert.equal(run(`nextLineup(Date.now()).length`), 10);
assert.equal(run(`nextLineup(Date.now()).filter(x => x.team === 'home').length`), 5);
context.dropOn('Player D', 'next', onto('Player M', 'court'));
assert.ok(court().includes('Player D') && !court().includes('Player M'));
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
// Each row also says which side the player was on: 0 home, 1 away.
assert.deepEqual(sent.find(r => r.name === 'Player B'), { name: 'Player B', points: 2, fgm: 1, fga: 2, won: 1, team: 0 });
assert.deepEqual(sent.find(r => r.name === 'Player A'), { name: 'Player A', points: 6, fgm: 0, fga: 0, won: 1, team: 0 });
assert.equal(sent.find(r => r.name === 'Player F').team, 1);
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
const onCourt1 = run(`state.game.onCourt.find(c => player(c.name).games).name`); // on the leaderboard's table
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

// Undo a check-in: someone who hasn't played goes back to To arrive; anyone else stays.
run(`state.players.push({ name: 'Oops New', games: 0, readyAt: 0, present: true, totalPoints: 0, fgm: 0, fga: 0, wins: 0, losses: 0 }); state.expected = state.expected.filter(n => n !== 'Oops New'); render();`);
assert.match(els.roster.innerHTML, /data-action="uncheck"\s+data-name="Oops New"/);
run(`actions.uncheck('Oops New'); commit();`);
assert.equal(els.msg.textContent, 'Oops New is back on To arrive.');
assert.equal(run(`player('Oops New')`), undefined);
assert.match(els.roster.innerHTML, /<b>Oops New<\/b><button class="btn s" data-action="checkIn"/);
const veteran = run(`state.players.find(p => p.games && !seatOf(p.name))?.name`);
if (veteran) {
  assert.doesNotMatch(els.roster.innerHTML, new RegExp(`data-action="uncheck"\\s+data-name="${veteran}"`));
  assert.equal(run(`actions.uncheck(${JSON.stringify(veteran)})`), false);
  assert.ok(run(`player(${JSON.stringify(veteran)})`));
}
// Someone on court, or subbed off this game, can't be sent back either.
const seated = run(`state.game.onCourt[0]?.name`);
if (seated) assert.equal(run(`actions.uncheck(${JSON.stringify(seated)})`), false);

// Switch sides: the board mirrors, saved on this laptop only (not in the shared session); the teams'
// scores don't move.
const score = () => [els.homeScore.textContent, els.awayScore.textContent].join();
const before = score();
run(`actions.flip(); commit();`);
assert.equal(storage.get('pickup-flipped'), '1');
assert.equal('flipped' in JSON.parse(storage.get('pickup-rotation-v1')), false);
assert.equal(score(), before);
run(`actions.flip(); commit();`);
assert.equal(storage.get('pickup-flipped'), '');

// Pending types survive a new session.
context.confirm = () => true;
const pendingBefore = run(`state.kinds.length`);
run(`actions.newSession(); render();`);
assert.equal(run(`state.kinds.length`), pendingBefore);

// The light / dark switch flips the page and remembers the choice on this device.
assert.equal(els.themeBtn.title, 'Switch to light mode');
run(`actions.theme()`);
assert.equal(context.document.documentElement.dataset.theme, 'light');
assert.equal(storage.get('pickup-theme'), 'light');
assert.equal(els.themeBtn.title, 'Switch to dark mode');
run(`actions.theme()`);
assert.equal(storage.get('pickup-theme'), 'dark');

// ---- Sharing: act() queues each change, adopt() lays the unsent ones back on the server's copy ----
const P = name => ({ name, games: 0, readyAt: 1, present: true, totalPoints: 0, fgm: 0, fga: 0, wins: 0, losses: 0 });
const seat = (name, team) => ({ name, team, points: 0, fgm: 0, fga: 0, log: [] });
const night = (startedAt, number = 1) => ({
  players: [P('Ann'), P('Bo')], expected: [], unsynced: [], kinds: [], startedAt,
  game: { number, onCourt: [seat('Ann', 'home'), seat('Bo', 'away')], subbedOut: [], satOut: [], homeName: 'Home', awayName: 'Away', remainingMs: 1200000, endsAt: null, started: false },
});
const use = n => run(`state = tidy(${JSON.stringify(n)}); pending = []; liveId = null; liveVer = 0; needsChoice = []; fresh = false;`);
const take = (n, version = 5) => run(`adopt(${JSON.stringify({ id: n.startedAt, version, state: n })})`);
const ops = () => run(`pending.map(c => c[0])`).join();
const ann = () => run(`seatOf('Ann').points`);

// A change is queued with its game number and a sequence number, and saved on its own, so a reload
// while offline keeps it. The sequence is also recorded in the shared state, under this laptop's id.
context.confirm = () => true;
use(night(100));
run(`act('make', 'Ann', '2')`);
assert.deepEqual(run(`pending`), [['make', 'Ann', '2', 1, 1]]);
assert.deepEqual(JSON.parse(storage.get('pickup-pending')), [['make', 'Ann', '2', 1, 1]]);
assert.equal(run(`state.seen[DEVICE]`), 1);
run(`act('make', 'Ann', '3')`);
assert.deepEqual(run(`pending.map(c => c[4])`), [1, 2]); // counting up
run(`act('undo', 'Ann')`);
assert.deepEqual(run(`pending.map(c => c[4])`), [1, 2, 3]);
use(night(100));
run(`act('make', 'Ann', '2')`);
assert.equal(run(`act('make', 'Ann', '1')`), false); // an action that did nothing is not queued
assert.equal(ops(), 'make');
// Another laptop checked in Zoe meanwhile; its copy lacks our +2. Taking it keeps the +2, once.
const theirs = night(100);
theirs.players.push(P('Zoe'));
take(theirs);
assert.equal(ann(), 2);
assert.equal(run(`player('Zoe').present`), true);
assert.equal(run(`liveVer`), 5);
assert.equal(ops(), 'make'); // still waiting for the server to accept it

// Replay shows no dialog and doesn't leave the tab. End game recorded on game 3 runs again on the
// server's game 3, but is skipped when the server has already gone on to game 4; a check-in, a change
// to the night as a whole, still applies.
use(night(100, 3));
run(`act('checkIn', 'Late Larry'); act('endGame'); active = 'board';`);
assert.equal(run(`state.game.number`), 4);
assert.equal(ops(), 'checkIn,endGame');
context.confirm = () => { throw new Error('a replayed change asked to confirm'); };
take(night(100, 3));
assert.equal(run(`state.game.number`), 4); // the game ended again, once
assert.equal(run(`state.unsynced.length`), 1);
assert.equal(run(`active`), 'board'); // End game would have moved to the Queue tab
assert.equal(run(`player('Late Larry').present`), true);
use(night(100, 3));
context.confirm = () => true;
run(`act('checkIn', 'Late Larry'); act('endGame');`);
take(night(100, 4)); // the other laptop already ended game 3
assert.equal(run(`state.game.number`), 4);
assert.equal(run(`state.unsynced.length`), 0);
assert.equal(ops(), 'checkIn');
assert.equal(run(`player('Late Larry').present`), true);

// Another laptop started a new session: switch to it, drop game changes, keep the check-in, say so.
use(night(100, 3));
run(`act('checkIn', 'Late Larry'); act('make', 'Ann', '2'); state.unsynced.push({ session: 100, game: 2, date: '2026-11-06', rows: [] }); needsChoice = [{ query: 'x', choices: [] }];`);
take(night(200), 1);
assert.equal(run(`state.startedAt`), 200);
assert.equal(ann(), 0);
assert.equal(ops(), 'checkIn');
assert.equal(run(`player('Late Larry').present`), true);
assert.equal(run(`state.unsynced.map(u => u.game).join()`), '2'); // a game the server never saw rides along
assert.equal(run(`needsChoice.length`), 0);
assert.match(els.msg.textContent, /new session/);
// Starting one here clears what was waiting: it belonged to the old session.
run(`act('newSession')`);
assert.equal(ops(), '');
assert.notEqual(run(`state.startedAt`), 200);

(async () => {
  const settle = () => new Promise(r => setImmediate(r));
  const fetched = [];
  let reply = () => ({ status: 204 });
  context.fetch = async (path, init = {}) => {
    fetched.push({ path, post: init.method === 'POST', body: init.body && JSON.parse(init.body) });
    const r = reply(path, init);
    return { status: r.status, ok: r.status < 400, json: async () => r.json };
  };
  const calls = () => fetched.splice(0);

  // Opened as a file, nothing reaches the network: changes just wait.
  use(night(100));
  run(`act('make', 'Ann', '2')`);
  await settle();
  assert.equal(fetched.length, 0);
  assert.equal(ops(), 'make');
  assert.equal(run(`db`), 'offline');
  assert.match(els.dbDot.title, /1 change waiting/);

  context.location.protocol = 'http:';
  // A push carries the whole session at the version this laptop knows (0 for a new one); once the
  // server accepts it the queue is empty. The per-laptop flip stays out of it.
  const live = n => ({ id: n.startedAt, date: '2026-11-06', state: n });
  use(night(100));
  reply = () => ({ status: 200, json: { version: 8 } });
  run(`act('make', 'Ann', '2')`);
  await settle();
  const [push] = calls();
  assert.deepEqual([push.path, push.post, push.body.id, push.body.version], ['/api/live', true, 100, 0]);
  assert.match(push.body.date, /^\d{4}-\d\d-\d\d$/);
  assert.equal(push.body.state.game.onCourt[0].points, 2);
  assert.equal('flipped' in push.body.state, false);
  assert.equal(ops(), '');
  assert.deepEqual(run(`[liveId, liveVer, db]`), [100, 8, 'online']);
  assert.match(els.dbDot.title, /online, live/);

  // Refused (409) because another laptop got there first: take its copy, lay ours on top, push again.
  const server = night(100);
  Object.assign(server.game.onCourt[0], { points: 2, fgm: 1, fga: 1, log: [2] });
  server.players.push(P('Zoe'));
  let n = 0;
  reply = () => (n++ === 0 ? { status: 409, json: { ...live(server), version: 10 } } : { status: 200, json: { version: 11 } });
  run(`act('make', 'Ann', '3')`);
  await settle();
  const [first, second] = calls();
  assert.equal(first.body.version, 8);
  assert.equal(second.body.version, 10);
  assert.equal(second.body.state.game.onCourt[0].points, 5); // their 2 and our 3
  assert.ok(second.body.state.players.some(p => p.name === 'Zoe'));
  assert.deepEqual(run(`[pending.length, liveVer]`), [0, 11]);

  // Typing a team name keeps the last key, not one change per key; the one in the air is left alone.
  reply = () => ({ status: 500 });
  run(`act('teamName', 'home', 'T')`);
  await settle();
  run(`act('teamName', 'home', 'Tw'); act('teamName', 'home', 'Twi');`);
  assert.deepEqual(run(`pending.map(c => c[2])`), ['Tw', 'Twi']); // 'Tw' replaced 'T'; it is now out, so 'Twi' follows it
  calls();

  // The poll: nothing new (204), a newer version (adopted), and a reply that is not newer (ignored).
  await settle();
  use(night(100));
  run(`liveId = 100; liveVer = 11; db = 'connecting';`);
  reply = () => ({ status: 204 });
  await run(`poll()`);
  assert.equal(calls()[0].path, '/api/live?id=100&v=11');
  assert.equal(run(`db`), 'online');
  const newer = night(100);
  newer.players.push(P('Cy'));
  reply = () => ({ status: 200, json: { ...live(newer), version: 12 } });
  await run(`poll()`);
  assert.equal(run(`player('Cy').present`), true);
  assert.equal(run(`liveVer`), 12);
  calls();
  run(`state.players = state.players.filter(p => p.name !== 'Cy')`);
  await run(`poll()`);
  assert.equal(run(`player('Cy')`), undefined); // same version again: ignored
  calls();
  // Not while the tab is hidden.
  context.document.hidden = true;
  await run(`poll()`);
  context.document.hidden = false;
  assert.equal(calls().length, 0);

  // Joining on load. The server has no session: share this laptop's. The server's is newer: take it.
  // This laptop's is newer (first run after deploy): share it too.
  use(night(100));
  reply = (path, init) => (init.method === 'POST' ? { status: 200, json: { version: 1 } } : { status: 204 });
  await run(`poll()`);
  await settle();
  let [get, post] = calls();
  assert.deepEqual([get.post, post.post, post.body.id, post.body.version], [false, true, 100, 0]);
  assert.equal(run(`liveId`), 100);
  use(night(100));
  reply = () => ({ status: 200, json: { ...live(night(300)), version: 4 } });
  await run(`poll()`);
  assert.deepEqual(run(`[state.startedAt, liveId, liveVer]`), [300, 300, 4]);
  calls();
  use(night(100));
  reply = (path, init) => (init.method === 'POST' ? { status: 200, json: { version: 1 } } : { status: 200, json: { ...live(night(50)), version: 9 } });
  await run(`poll()`);
  await settle();
  [get, post] = calls();
  assert.deepEqual([post.post, post.body.id, post.body.version, run(`state.startedAt`)], [true, 100, 0, 100]);

  const withZoe = () => { const n = night(100); n.players.push(P('Zoe')); return n; };
  // A laptop with nothing saved joins the server's session, whatever its own new id says: it never
  // pushes its empty one over the night everyone else is in. Check-ins made before joining survive.
  await settle();
  use(night(200));
  run(`fresh = true`);
  reply = (path, init) => (init.method === 'POST' ? { status: 200, json: { version: 1 } } : { status: 200, json: { ...live(withZoe()), version: 3 } });
  await run(`poll()`);
  await settle();
  assert.deepEqual(calls().map(c => c.post), [false]); // nothing pushed
  assert.deepEqual(run(`[state.startedAt, state.players.map(p => p.name).join(), fresh]`), [100, 'Ann,Bo,Zoe', false]);
  use(night(200));
  run(`fresh = true; act('checkIn', 'Late Larry')`);
  await settle();
  assert.equal(fetched.length, 0); // not even the check-in is pushed before joining
  await run(`poll()`);
  await settle();
  assert.deepEqual(run(`[state.startedAt, state.players.map(p => p.name).join(), pending.map(c => c[0]).join()]`), [100, 'Ann,Bo,Zoe,Late Larry', '']);
  const [, up] = calls(); // joined first; then the check-in went up on the server's session, and was accepted
  assert.deepEqual([up.post, up.body.id, up.body.version, up.body.state.players.length], [true, 100, 3, 4]);
  // The server has no session at all: a fresh laptop creates it.
  use(night(200));
  run(`fresh = true`);
  reply = (path, init) => (init.method === 'POST' ? { status: 200, json: { version: 1 } } : { status: 204 });
  await run(`poll()`);
  await settle();
  assert.deepEqual(calls().map(c => [c.post, c.body?.id]), [[false, undefined], [true, 200]]);
  assert.equal(run(`fresh`), false);
  // New session on any laptop is meant: it becomes the current one even though a session exists.
  use(night(100));
  run(`fresh = true; act('newSession')`);
  assert.equal(run(`fresh`), false);
  await settle();
  assert.equal(calls().filter(c => c.post).length, 1);

  // A push the server accepted but whose reply was lost: the next copy already holds the change, so it
  // is not applied a second time.
  use(night(100));
  run(`liveId = 100; liveVer = 1`);
  let sent;
  reply = (path, init) => { sent = JSON.parse(init.body); throw new Error('connection lost'); };
  run(`act('make', 'Ann', '2')`);
  await settle();
  assert.equal(run(`db`), 'offline');
  assert.equal(ops(), 'make'); // still waiting: it is not known to have arrived
  calls();
  reply = () => ({ status: 200, json: { id: 100, date: '2026-11-06', version: 2, state: sent.state } });
  await run(`poll()`);
  assert.equal(ann(), 2); // once, not 4
  assert.equal(ops(), '');
  assert.deepEqual(calls().map(c => c.post), [false]); // and nothing left to push

  // Games and types go to the database only once the shared copy holds them, then come off as a change.
  use(night(100));
  reply = () => ({ status: 200, json: [] });
  run(`state.unsynced.push({ session: 100, date: '2026-11-06', game: 1, rows: [] }); state.kinds.push({ name: 'Ann', kind: 'UG' });`);
  await run(`sync()`);
  assert.deepEqual(calls().map(c => c.path), ['/api/profiles']); // not shared yet: nothing posted
  run(`liveId = 100; liveVer = 3;`);
  reply = path => (path === '/api/live' ? { status: 200, json: { version: 4 } } : { status: 200, json: [] });
  await run(`sync()`);
  await settle();
  // Each post is followed by the push that takes it off the list; the last profiles is sync running again.
  assert.deepEqual(calls().map(c => c.path), ['/api/profiles', '/api/results', '/api/live', '/api/kind', '/api/live', '/api/profiles']);
  assert.deepEqual(run(`[state.unsynced.length, state.kinds.length, pending.length]`), [0, 0, 0]);

  // A 401 asks for the passcode once and stops polling until it is entered.
  reply = () => ({ status: 401 });
  await run(`poll()`);
  assert.equal(run(`db`), 'locked');
  calls();
  await run(`poll()`);
  assert.equal(calls().length, 0);
  run(`db = 'connecting'`);

  // History: the list, then a session's box scores fetched when it first opens.
  reply = () => ({ status: 200, json: [{ id: 5, date: '2026-11-06', players: 12, games: 1 }, { id: 4, date: '2026-10-30', players: 1, games: 2 }] });
  await run(`renderHistory()`);
  assert.match(els.historyList.innerHTML, /<details class="dd" data-id="5"><summary>2026-11-06<span class="mono">12 players · 1 game<\/span>/);
  assert.match(els.historyList.innerHTML, /1 player · 2 games/);
  const detail = {
    id: 5, date: '2026-11-06', participants: ['Ana', 'Ben <b>'], games: [
      { game: 1, rows: [{ name: 'Ana', points: 7, fgm: 3, fga: 8, won: 1, team: 0 }, { name: 'Cy', points: 3, fgm: 1, fga: 2, won: 1, team: 0 }, { name: 'Ben <b>', points: 2, fgm: 1, fga: 4, won: 0, team: 1 }] },
      { game: 2, rows: [{ name: 'Old Timer', points: 4, fgm: 0, fga: 0, won: null, team: null }] },
    ],
  };
  const body = { innerHTML: '' }, details = { open: true, dataset: { id: '5' }, querySelector: () => body };
  reply = path => ({ status: 200, json: path === '/api/sessions/5' ? detail : [] });
  const [, onToggle] = histListeners.find(([type]) => type === 'toggle');
  await onToggle({ target: details });
  assert.equal(calls().at(-1).path, '/api/sessions/5');
  assert.match(body.innerHTML, /Players: Ana, Ben &#60;b&#62;/); // names go through esc
  assert.doesNotMatch(body.innerHTML, /Ben <b>/);
  assert.match(body.innerHTML, /<h4>Game 1<\/h4><div class="tw"><table><thead><tr><th>Home<\/th>[\s\S]*?<td>Ana<\/td>[\s\S]*?<td><b>Total<\/b><\/td><td class="r mono"><b>10<\/b><\/td>[\s\S]*?<th>Away<\/th>[\s\S]*?<td><b>Total<\/b><\/td><td class="r mono"><b>2<\/b>/);
  assert.match(body.innerHTML, /<h4>Game 2<\/h4>[^]*?<th>Player<\/th>[^]*?<td>Old Timer<\/td>/); // no teams stored: one list, no totals
  assert.equal((body.innerHTML.match(/Total/g) || []).length, 2);
  assert.equal(details.dataset.shown, '1'); // opened once: not fetched again
  await onToggle({ target: details });
  assert.equal(fetched.length, 0);
  // Offline: one line, and it tries again next time.
  const shut = { open: true, dataset: { id: '5' }, querySelector: () => body };
  reply = () => ({ status: 500 });
  await onToggle({ target: shut });
  assert.match(body.innerHTML, /<p class="empty">Could not load this session\. History needs a connection\.<\/p>/);
  assert.equal(shut.dataset.shown, undefined);
  await run(`renderHistory()`);
  assert.match(els.historyList.innerHTML, /<p class="empty">History needs a connection\.<\/p>/);

  context.location.protocol = 'file:';
  console.log('app.test.js: all checks passed');
})();
