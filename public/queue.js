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

  // Undo a call: back in line exactly where they were, with no sit-out mark,
  // so Fill may call them again.
  remove(game, name) {
    game.onCourt = game.onCourt.filter(c => c.name !== name);
  },

  // Off the court with nothing counted: games and readyAt are untouched,
  // so the player keeps their place and leads the next game.
  sitOut(game, name) {
    Queue.remove(game, name);
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

  // Everyone who played this game: on court now, plus anyone subbed off after play started.
  played: game => [...game.onCourt, ...(game.subbedOut ?? [])],

  // Substitution: inName takes outName's seat and team. Once play has started (keep), the player
  // coming off goes to game.subbedOut with their points, so the team score holds and the game
  // counts for them too; before that it is a plain swap. Someone coming back on gets their points
  // back, so each player stays one row in the results. A sub who comes back off without scoring
  // is treated as an undo (a sub made by mistake): they leave no row and the game doesn't count.
  // ponytail: a player coming back for the other team brings their points along; split per team if that ever happens
  // ponytail: a sub who played a while and scored nothing also leaves no row; track minutes if that matters
  sub(game, outName, inName, keep) {
    const seat = game.onCourt.find(c => c.name === outName);
    if (!seat || game.onCourt.some(c => c.name === inName)) return;
    const off = (game.subbedOut ??= []);
    const back = off.findIndex(c => c.name === inName);
    const points = back < 0 ? 0 : off.splice(back, 1)[0].points;
    if (keep && !(seat.sub && !seat.points)) off.push({ name: seat.name, team: seat.team, points: seat.points });
    Object.assign(seat, { name: inName, points, sub: true });
    game.satOut = game.satOut.filter(n => n !== inName);
  },

  // Count the game for everyone who played it.
  endGame(players, game, now) {
    for (const c of Queue.played(game)) {
      const p = players.find(p => p.name === c.name);
      p.games += 1;
      p.readyAt = now;
      p.totalPoints += c.points;
    }
  },

  // Who Fill will call for the following game: end this game on a copy, then
  // fill a fresh one. Same rule as Fill, so the queue diagram can't disagree.
  nextGame(players, game, spots, now) {
    const copy = players.map(p => ({ ...p }));
    Queue.endGame(copy, game, now);
    return Queue.nextInLine(copy, { onCourt: [], satOut: [] }, spots);
  },

  // Tonight's leaderboard, by total points or by points per game. Rows are
  // { player, perGame, rank }. Ties share a rank (1, 2, 2, 4). Players who haven't
  // played get no rank, and in per-game mode neither does anyone under minGames:
  // one lucky game shouldn't top the board. Unranked players are listed last.
  leaderboard(players, mode, minGames) {
    const rows = players.map(p => ({ player: p, perGame: p.games ? Math.round((p.totalPoints / p.games) * 10) / 10 : null }));
    const ranked = r => r.player.games >= (mode === 'perGame' ? minGames : 1);
    const key = r => (mode === 'perGame' ? r.perGame ?? -1 : r.player.totalPoints);
    rows.sort((a, b) => ranked(b) - ranked(a) || key(b) - key(a)
      || b.player.totalPoints - a.player.totalPoints || a.player.name.localeCompare(b.player.name));
    return rows.map(r => ({ ...r, rank: ranked(r) ? rows.findIndex(q => key(q) === key(r)) + 1 : null }));
  },

  seat: name => ({ name, team: null, points: 0 }),
};

if (typeof module !== 'undefined') module.exports = Queue;
