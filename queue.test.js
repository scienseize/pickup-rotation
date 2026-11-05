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

// Game 3: latecomer first, then the 1-game tier by wait time, then fillers.
game = newGame(3);
Queue.fill(players, game, 10);
assert.equal(called(game), 'NHIJKLMABC');
Queue.endGame(players, game, 300);

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
  assert.deepEqual(g.subbedOut, [{ name: 'B', team: 'home', points: 6 }]);
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
// Games saved before substitutions existed have no subbedOut list.
assert.equal(Queue.played({ onCourt: [Queue.seat('A')] }).length, 1);

console.log('queue.test.js: all checks passed');
