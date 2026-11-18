// Run: node queue.test.js
const assert = require('node:assert');
const Queue = require('./public/queue.js');

const join = (name, readyAt) => ({ name, games: 0, readyAt, present: true, totalPoints: 0 });
const newGame = number => ({ number, onCourt: [], satOut: [] });
const called = game => game.onCourt.map(c => c.name).join('');

const players = [...'ABCDEFGHIJKLM'].map(join);

// Game 1: first 10 by check-in.
let game = newGame(1);
Queue.fill(players, game, 10);
assert.equal(called(game), 'ABCDEFGHIJ');
game.onCourt[0].points = 7;
// nextGame predicts game 2 without touching the real players.
assert.equal(Queue.nextGame(players, game, 10, 100).map(p => p.name).join(''), 'KLMABCDEFG');
assert.equal(players[0].games, 0);
Queue.endGame(players, game, 100);
assert.equal(players[0].games, 1);
assert.equal(players[0].totalPoints, 7);

// Game 2: the 3 who haven't played, then fillers with the fewest games.
game = newGame(2);
Queue.fill(players, game, 10);
assert.equal(called(game), 'KLMABCDEFG');
players.push(join('N', 150)); // arrives mid-game
Queue.endGame(players, game, 200);

// Game 3: latecomer first, then the 1-game tier in check-in order, then fillers.
game = newGame(3);
Queue.fill(players, game, 10);
assert.equal(called(game), 'NHIJKLMABC');
Queue.endGame(players, game, 300);

// Order is game count, then longest wait. P checked in first but has been ready for less time
// than Q (P just played), so Q goes first; R has fewer games and leads both.
assert.equal(Queue.waitingOrder([
  { name: 'P', games: 1, readyAt: 900, present: true },
  { name: 'Q', games: 1, readyAt: 100, present: true },
  { name: 'R', games: 0, readyAt: 950, present: true },
], newGame(1)).map(p => p.name).join(''), 'RQP');
// The same rule picks the next game: X and Y are tied at 1 game once this one ends, and Y, who
// sat it out waiting, goes ahead of X, who is on court and checked in first.
assert.equal(Queue.nextGame([
  { name: 'X', games: 0, readyAt: 1, present: true, totalPoints: 0 },
  { name: 'Y', games: 1, readyAt: 50, present: true, totalPoints: 0 },
], { onCourt: [{ name: 'X', team: 'home', points: 0 }], satOut: [] }, 1, 100)[0].name, 'Y');

// Sit out: no game counted, not re-called by Fill, not "passed over", leads next game.
game = newGame(4);
Queue.fill(players, game, 10);
const refuser = game.onCourt[0].name;
const gamesBefore = players.find(p => p.name === refuser).games;
Queue.sitOut(game, refuser);
Queue.fill(players, game, 10);
assert.equal(game.onCourt.length, 10);
assert.ok(!called(game).includes(refuser));
assert.deepEqual(Queue.passedOver(players, game), []);
Queue.endGame(players, game, 400);
assert.equal(players.find(p => p.name === refuser).games, gamesBefore);
game = newGame(5);
Queue.fill(players, game, 10);
assert.equal(game.onCourt[0].name, refuser);

// Remove: off the court with no sit-out mark and nothing counted, so Fill calls them again.
const removed = game.onCourt[1].name;
Queue.remove(game, removed);
assert.equal(game.onCourt.length, 9);
assert.deepEqual(game.satOut, []);
Queue.fill(players, game, 10);
assert.ok(called(game).includes(removed));

// Hand-pick: a player with the most games skips players with fewer, who get flagged.
game = newGame(6);
const most = players.reduce((a, b) => (b.games > a.games ? b : a));
Queue.pick(game, most.name, 10);
const flagged = Queue.passedOver(players, game);
assert.ok(flagged.length > 0);
assert.ok(flagged.every(n => players.find(p => p.name === n).games < most.games));
Queue.pick(game, most.name, 10); // picking twice does nothing
assert.equal(game.onCourt.length, 1);

// Leaderboard: totals rank everyone who played; per game needs 2 games and puts the rest last.
const lbPlayers = [
  { name: 'Ana', games: 3, totalPoints: 24 }, // 8.0 a game
  { name: 'Ben', games: 2, totalPoints: 20 }, // 10.0
  { name: 'Cy', games: 1, totalPoints: 12 }, // 12.0, but only one game
  { name: 'Dee', games: 2, totalPoints: 16 }, // 8.0, ties Ana per game
  { name: 'Eli', games: 0, totalPoints: 0 },
];
const board = mode => Queue.leaderboard(lbPlayers, mode, 2).map(r => `${r.rank ?? '-'}${r.player.name}`).join(' ');
assert.equal(board('total'), '1Ana 2Ben 3Dee 4Cy -Eli');
assert.equal(board('perGame'), '1Ben 2Ana 2Dee -Cy -Eli');
assert.equal(Queue.leaderboard(lbPlayers, 'perGame', 2).find(r => r.player.name === 'Cy').perGame, 12);

// Substitution: before play it is a plain swap; once play has started the player coming off
// keeps their points (the team score holds) and the game counts for both.
{
  const subs = [...'ABCDEFGHIJKL'].map(join);
  const g = newGame(1);
  Queue.fill(subs, g, 10);
  g.onCourt.forEach((c, i) => { c.team = i < 5 ? 'home' : 'away'; });
  Queue.sub(g, 'A', 'K', false);
  assert.equal(called(g), 'KBCDEFGHIJ');
  assert.deepEqual(g.subbedOut, []);
  assert.equal(g.onCourt[0].team, 'home');
  g.onCourt[1].points = 6; // B
  Queue.sub(g, 'B', 'L', true);
  assert.equal(called(g), 'KLCDEFGHIJ');
  assert.deepEqual(g.subbedOut, [{ name: 'B', team: 'home', points: 6, fgm: 0, fga: 0, log: [], half: false }]);
  const homeScore = () => Queue.played(g).filter(c => c.team === 'home').reduce((t, c) => t + c.points, 0);
  assert.equal(homeScore(), 6);
  Queue.sub(g, 'K', 'K', true); // already on court: nothing happens
  Queue.sub(g, 'Z', 'A', true); // nobody called Z on court: nothing happens
  assert.equal(called(g), 'KLCDEFGHIJ');
  // B is waiting again and comes back on for C, bringing their 6 points: one row each.
  assert.ok(Queue.waitingOrder(subs, g).some(p => p.name === 'B'));
  Queue.sub(g, 'C', 'B', true);
  assert.deepEqual(g.subbedOut.map(c => c.name), ['C']);
  assert.equal(g.onCourt.find(c => c.name === 'B').points, 6);
  assert.equal(homeScore(), 6);
  const names = Queue.played(g).map(c => c.name);
  assert.equal(new Set(names).size, names.length);
  // A sub made by mistake and swapped straight back (the sub scored nothing) leaves no trace.
  Queue.sub(g, 'D', 'A', true);
  Queue.sub(g, 'A', 'D', true);
  assert.deepEqual(g.subbedOut.map(c => c.name), ['C']);
  assert.equal(called(g), 'KLBDEFGHIJ');
  // The game counts for C (subbed off) and for B, L (subbed on), not for A (swapped out before play).
  Queue.endGame(subs, g, 500);
  assert.deepEqual(subs.filter(p => p.games).map(p => p.name).join(''), 'BCDEFGHIJKL');
  assert.equal(subs.find(p => p.name === 'B').totalPoints, 6);
}
// Shots: they travel with the player through a sub and back, count at the end of the game, and
// give the leaderboard's FG%. A sub with no points but a missed shot played, so they keep a row.
{
  const ps = [...'ABCDEFGHIJKL'].map(join);
  const g = newGame(1);
  Queue.fill(ps, g, 10);
  g.onCourt.forEach((c, i) => { c.team = i < 5 ? 'home' : 'away'; });
  Object.assign(g.onCourt[0], { points: 5, fgm: 2, fga: 4, log: [2, 0, 3, 0] }); // A: 2 of 4
  Queue.sub(g, 'A', 'K', true);
  assert.deepEqual(g.subbedOut[0], { name: 'A', team: 'home', points: 5, fgm: 2, fga: 4, log: [2, 0, 3, 0], half: false });
  assert.deepEqual([g.onCourt[0].fgm, g.onCourt[0].fga, g.onCourt[0].log], [0, 0, []]); // K starts clean
  g.onCourt[0].fga = 1; // K misses once
  Queue.sub(g, 'K', 'A', true); // A comes back with their shots; K played, so K keeps a row
  assert.deepEqual([g.onCourt[0].name, g.onCourt[0].fgm, g.onCourt[0].fga], ['A', 2, 4]);
  assert.deepEqual(g.subbedOut.map(c => c.name), ['K']);
  Queue.endGame(ps, g, 900);
  const a = ps.find(p => p.name === 'A'), k = ps.find(p => p.name === 'K');
  assert.deepEqual([a.fgm, a.fga, k.fgm, k.fga, k.games], [2, 4, 0, 1, 1]);
  const lb = Queue.leaderboard(ps, 'total', 2);
  assert.equal(lb.find(r => r.player.name === 'A').fgPct, 50);
  assert.equal(lb.find(r => r.player.name === 'K').fgPct, 0);
  assert.equal(lb.find(r => r.player.name === 'B').fgPct, null); // no attempts
}

// Wins: the higher score wins, counting players subbed off; a tie gives neither.
{
  const ps = [...'ABCDEFGHIJK'].map(join);
  const g = newGame(1);
  Queue.fill(ps, g, 10);
  g.onCourt.forEach((c, i) => { c.team = i < 5 ? 'home' : 'away'; });
  g.onCourt[0].points = 4; // A, home
  g.onCourt[5].points = 6; // F, away
  Queue.sub(g, 'F', 'K', true); // F's 6 go off court with F but still count for Away
  assert.equal(Queue.winner(g), 'away');
  assert.deepEqual([Queue.won(g, g.onCourt[0]), Queue.won(g, g.subbedOut[0])], [0, 1]);
  Queue.endGame(ps, g, 1000);
  const rec = n => { const p = ps.find(x => x.name === n); return [p.wins, p.losses]; };
  assert.deepEqual([rec('A'), rec('F'), rec('K')], [[0, 1], [1, 0], [1, 0]]);
  const tie = newGame(2);
  tie.onCourt = [{ ...Queue.seat('A'), team: 'home', points: 2 }, { ...Queue.seat('B'), team: 'away', points: 2 }];
  assert.equal(Queue.winner(tie), null);
  Queue.endGame(ps, tie, 2000);
  assert.deepEqual(rec('A'), [0, 1]); // a tie adds neither
  assert.equal(ps.find(x => x.name === 'A').games, 2); // but the game counts
}

// Late arrivals: priority for their first game only, then the normal rotation. 14 at the start;
// O and P arrive during game 2, Q during game 4. Each plays the next game, then waits like everyone
// who just played: nobody plays two games in a row while someone present has played fewer.
{
  const ps = [...'ABCDEFGHIJKLMN'].map(join);
  const games = [];
  let t = 1000;
  for (let n = 1; n <= 9; n++) {
    const g = newGame(n);
    Queue.fill(ps, g, 10);
    games.push(called(g));
    if (n === 2) ps.push({ ...join('O', ++t), late: true }, { ...join('P', ++t), late: true });
    if (n === 4) ps.push({ ...join('Q', ++t), late: true });
    Queue.endGame(ps, g, (t += 10));
  }
  const inGame = (name, n) => games[n - 1].includes(name);
  assert.ok(inGame('O', 3) && inGame('P', 3) && !inGame('O', 4) && !inGame('P', 4), games.join(' '));
  assert.ok(inGame('Q', 5) && !inGame('Q', 6), games.join(' '));
  // After their first game a latecomer's turns match the fewest anyone else here has.
  const counts = ps.map(Queue.turn);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, counts.join());
  assert.ok(ps.every(p => !p.late));
  // games stays the stat: Q played 4 games (5, and three more in rotation), whatever their turns.
  assert.equal(ps.find(p => p.name === 'Q').games, games.filter(g => g.includes('Q')).length);
  // A late arrival with nobody else present keeps a plain count.
  const solo = [{ ...join('Z', 1), late: true }];
  const g = newGame(1);
  Queue.fill(solo, g, 10);
  Queue.endGame(solo, g, 2);
  assert.equal(solo[0].turns, 1);
}

// Mid-game subs count half a game for both players in the rotation; games played stays whole.
{
  const ps = [...'ABCDEFGHIJKL'].map(join);
  const g = newGame(1);
  Queue.fill(ps, g, 10);
  g.onCourt.forEach((c, i) => { c.team = i < 5 ? 'home' : 'away'; });
  Queue.sub(g, 'A', 'K', true); // after the start: A off, K on
  Queue.sub(g, 'B', 'L', false); // before the start (a plain swap): L plays the whole game
  Queue.sub(g, 'C', 'B', true); // B comes on for C mid-game, then goes straight back: an undo
  Queue.sub(g, 'B', 'C', true);
  Queue.endGame(ps, g, 100);
  const turn = n => Queue.turn(ps.find(p => p.name === n));
  const played = n => ps.find(p => p.name === n).games;
  assert.deepEqual(['A', 'K', 'L', 'C', 'B', 'D'].map(turn), [0.5, 0.5, 1, 1, 0, 1]);
  assert.deepEqual(['A', 'K', 'L', 'C', 'B'].map(played), [1, 1, 1, 1, 0]);
  // Half a turn sorts ahead of a whole one: A and K lead their tier next game.
  const next = Queue.waitingOrder(ps, newGame(2)).map(p => p.name);
  assert.deepEqual(next.slice(0, 3), ['B', 'A', 'K']);
  // A subbed-off player who comes back on later in the game still counts half, as does the one leaving.
  const g2 = newGame(2);
  const qs = [...'ABCDEFGHIJK'].map(join);
  Queue.fill(qs, g2, 10);
  Queue.sub(g2, 'A', 'K', true);
  g2.onCourt[0].points = 2; // K scores, so K's leaving is not an undo
  Queue.sub(g2, 'K', 'A', true);
  Queue.endGame(qs, g2, 200);
  assert.deepEqual(['A', 'K'].map(n => Queue.turn(qs.find(p => p.name === n))), [0.5, 0.5]);
}

// Games saved before substitutions existed have no subbedOut list.
assert.equal(Queue.played({ onCourt: [Queue.seat('A')] }).length, 1);

console.log('queue.test.js: all checks passed');
