// Fairness rules for the pick-up queue. No DOM and nothing sport-specific:
// the number of spots comes from the caller (basketball 10, volleyball 12).
// A plain script (not a module) so index.html works when opened from file://.

const Queue = {
  // Present players not on court, in the order they should be called:
  // fewest games first, then longest wait. Array.sort is stable, so ties
  // (everyone in a game finishes at once) keep check-in order.
  waitingOrder(players, game) {
    const called = new Set(game.onCourt.map(c => c.name));
    return players
      .filter(p => p.present && !called.has(p.name))
      .sort((a, b) => a.games - b.games || a.readyAt - b.readyAt);
  },

  // Players Fill would call, skipping anyone sitting out this game.
  nextInLine(players, game, spots) {
    const open = Math.max(0, spots - game.onCourt.length);
    return Queue.waitingOrder(players, game)
      .filter(p => !game.satOut.includes(p.name))
      .slice(0, open);
  },

  fill(players, game, spots) {
    for (const p of Queue.nextInLine(players, game, spots)) game.onCourt.push(Queue.seat(p.name));
  },

  // Hand-pick a specific waiting player into an open spot.
  pick(game, name, spots) {
    if (game.onCourt.length >= spots || game.onCourt.some(c => c.name === name)) return;
    game.satOut = game.satOut.filter(n => n !== name);
    game.onCourt.push(Queue.seat(name));
  },

  // Off the court with nothing counted: games and readyAt are untouched,
  // so the player keeps their place and leads the next game.
  sitOut(game, name) {
    game.onCourt = game.onCourt.filter(c => c.name !== name);
    if (!game.satOut.includes(name)) game.satOut.push(name);
  },

  // Waiting players with fewer games than someone called, i.e. skipped by a
  // hand-pick. Players who chose to sit out are not counted as skipped.
  passedOver(players, game) {
    const games = new Map(players.map(p => [p.name, p.games]));
    const most = Math.max(-1, ...game.onCourt.map(c => games.get(c.name)));
    return Queue.waitingOrder(players, game)
      .filter(p => p.games < most && !game.satOut.includes(p.name))
      .map(p => p.name);
  },

  // Count the game for everyone on court.
  endGame(players, game, now) {
    for (const c of game.onCourt) {
      const p = players.find(p => p.name === c.name);
      p.games += 1;
      p.readyAt = now;
      p.totalPoints += c.points;
    }
  },

  seat: name => ({ name, team: null, points: 0 }),
};

if (typeof module !== 'undefined') module.exports = Queue;
