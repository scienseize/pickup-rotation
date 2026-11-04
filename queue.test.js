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

console.log('queue.test.js: all checks passed');
