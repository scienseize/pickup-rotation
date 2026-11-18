// Fairness rules for the pick-up queue. No DOM and nothing sport-specific:
// the number of spots comes from the caller (basketball 10, volleyball 12).
// A plain script (not a module) so index.html works when opened from file://.

const Queue = {
  // A player's place in the rotation: turns, which counts a mid-game sub as half a game for both
  // players and moves a latecomer to the normal rotation after their first game. games stays the
  // stat (games played). Players saved before turns existed use games.
  turn: p => p.turns ?? p.games,

  // Present players not on court, in the order they should be called: fewest
  // turns first, so nobody repeats until everyone has played. Ties go to whoever
  // has waited longest (readyAt: check-in, or the end of their last game), then
  // to check-in order (Array.sort is stable).
  waitingOrder(players, game) {
    const called = new Set(game.onCourt.map(c => c.name));
    return players
      .filter(p => p.present && !called.has(p.name))
      .sort((a, b) => Queue.turn(a) - Queue.turn(b) || a.readyAt - b.readyAt);
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
    const turns = new Map(players.map(p => [p.name, Queue.turn(p)]));
    const most = Math.max(-1, ...game.onCourt.map(c => turns.get(c.name)));
    return Queue.waitingOrder(players, game)
      .filter(p => Queue.turn(p) < most && !game.satOut.includes(p.name))
      .map(p => p.name);
  },

  // Everyone who played this game: on court now, plus anyone subbed off after play started.
  played: game => [...game.onCourt, ...(game.subbedOut ?? [])],

  // Substitution: inName takes outName's seat and team. Once play has started (keep), the player
  // coming off goes to game.subbedOut with their points and shots, so the team score holds and the
  // game counts for them too; before that it is a plain swap. Someone coming back on gets their
  // points and shots back, so each player stays one row in the results. A sub who comes back off
  // without a shot is treated as an undo (a sub made by mistake): no row, and the game doesn't count.
  // After the start, both players in a sub play half the game (half: they count half a turn); an undo
  // gives the returning player back the status they had before. Before the start it is a full game.
  // ponytail: a player coming back for the other team brings their points along; split per team if that ever happens
  // ponytail: a sub who played a while and scored nothing also leaves no row; track minutes if that matters
  sub(game, outName, inName, keep) {
    const seat = game.onCourt.find(c => c.name === outName);
    if (!seat || game.onCourt.some(c => c.name === inName)) return;
    const off = (game.subbedOut ??= []);
    const back = off.findIndex(c => c.name === inName);
    const was = back < 0 ? Queue.seat(inName) : off.splice(back, 1)[0];
    const stats = c => ({ points: c.points, fgm: c.fgm ?? 0, fga: c.fga ?? 0, log: c.log ?? [] });
    const undo = keep && seat.sub && !seat.points && !seat.fga;
    if (keep && !undo) off.push({ name: seat.name, team: seat.team, ...stats(seat), half: !!seat.half });
    Object.assign(seat, { name: inName, ...stats(was), sub: true, half: keep && !(undo && back >= 0 && !was.half) });
    game.satOut = game.satOut.filter(n => n !== inName);
  },

  // The winning team: whoever scored more, counting players subbed off; null on a tie.
  winner(game) {
    const total = t => Queue.played(game).filter(c => c.team === t).reduce((n, c) => n + c.points, 0);
    const home = total('home'), away = total('away');
    return home === away ? null : home > away ? 'home' : 'away';
  },
  // A player's result in this game: 1 a win, 0 a loss, null on a tie.
  won: (game, c) => { const w = Queue.winner(game); return w === null ? null : c.team === w ? 1 : 0; },

  // Count the game for everyone who played it: games, points, shots, and a win or a loss. Turns go up
  // by 1, or by half for both players in a mid-game sub (subbed off, or on court with half). A late
  // arrival's first game puts them in the normal rotation: their turns rise to the fewest any other
  // present player has, so the priority covers only that first game.
  endGame(players, game, now) {
    const off = new Set((game.subbedOut ?? []).map(c => c.name));
    const late = [];
    for (const c of Queue.played(game)) {
      const p = players.find(p => p.name === c.name);
      p.turns = Queue.turn(p) + (off.has(c.name) || c.half ? 0.5 : 1);
      if (p.late) { late.push(p); delete p.late; }
      p.games += 1;
      p.readyAt = now;
      p.totalPoints += c.points;
      p.fgm = (p.fgm ?? 0) + (c.fgm ?? 0);
      p.fga = (p.fga ?? 0) + (c.fga ?? 0);
      const won = Queue.won(game, c);
      if (won !== null) { p.wins = (p.wins ?? 0) + won; p.losses = (p.losses ?? 0) + 1 - won; }
    }
    const level = Math.min(...players.filter(p => p.present && !late.includes(p)).map(Queue.turn));
    for (const p of late) if (Number.isFinite(level) && level > p.turns) p.turns = level; // nobody else here: nothing to match
  },

  // Who Fill will call for the following game: end this game on a copy, then
  // fill a fresh one. Same rule as Fill, so the queue diagram can't disagree.
  nextGame(players, game, spots, now) {
    const copy = players.map(p => ({ ...p }));
    Queue.endGame(copy, game, now);
    return Queue.nextInLine(copy, { onCourt: [], satOut: [] }, spots);
  },

  // Tonight's leaderboard, by total points or by points per game. Rows are
  // { player, perGame, fgPct, rank }; fgPct is made / attempted as a whole percent, null with no
  // attempts, and doesn't affect the ranking. Ties share a rank (1, 2, 2, 4). Players who haven't
  // played get no rank, and in per-game mode neither does anyone under minGames:
  // one lucky game shouldn't top the board. Unranked players are listed last.
  leaderboard(players, mode, minGames) {
    const rows = players.map(p => ({ player: p, perGame: p.games ? Math.round((p.totalPoints / p.games) * 10) / 10 : null }));
    const ranked = r => r.player.games >= (mode === 'perGame' ? minGames : 1);
    const key = r => (mode === 'perGame' ? r.perGame ?? -1 : r.player.totalPoints);
    rows.sort((a, b) => ranked(b) - ranked(a) || key(b) - key(a)
      || b.player.totalPoints - a.player.totalPoints || a.player.name.localeCompare(b.player.name));
    return rows.map(r => ({ ...r, rank: ranked(r) ? rows.findIndex(q => key(q) === key(r)) + 1 : null,
      fgPct: r.player.fga ? Math.round((r.player.fgm / r.player.fga) * 100) : null }));
  },

  // A spot on court. log is the player's scoring taps in order (0 a miss, 2 or 3 a make), for Undo.
  seat: name => ({ name, team: null, points: 0, fgm: 0, fga: 0, log: [] }),
};

if (typeof module !== 'undefined') module.exports = Queue;
