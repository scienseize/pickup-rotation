// Basketball session: state, saving, rendering, scoreboard and clock.
// The fairness rules live in queue.js.

const GAME_MINUTES = 20;
const TEAM_SIZE = 5; // volleyball will be 6
const SPOTS = TEAM_SIZE * 2;
const GAME_MS = GAME_MINUTES * 60000;
const KEY = 'pickup-rotation-v1';
const MIN_RANKED_GAMES = 2; // per-game ranking: one lucky game shouldn't top the board

const $ = id => document.getElementById(id);
const newGame = number => ({
  number, onCourt: [], subbedOut: [], satOut: [], homeName: 'Home', awayName: 'Away',
  remainingMs: GAME_MS, endsAt: null, started: false,
});
const newSession = () => ({ players: [], game: newGame(1), expected: [], unsynced: [], startedAt: Date.now() });

let state = load();
let saved = true;
let audio; // created on the first click; browsers block sound before one
const PASS_KEY = 'pickup-passcode', PROFILES_KEY = 'pickup-profiles';
const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
// lowercase name -> { name, games, points, avg }; the last copy is kept so profiles still show offline
let profiles = new Map((JSON.parse(stored(PROFILES_KEY)) || []).map(p => [p.name.toLowerCase(), p]));
let leaderMode = 'total'; // 'total' | 'perGame', the leaderboard toggle
let db = 'connecting'; // 'online' | 'offline' | 'locked' (needs the organizer passcode)

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s) {
      delete s.roster; // replaced by the database
      delete s.log; // never read
      const st = { expected: [], unsynced: [], startedAt: Date.now(), ...s };
      seatTeams(st.game); // saved before every called player had a team
      return st;
    }
  } catch {}
  return newSession();
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); saved = true; }
  catch { saved = false; flash('Could not save. Changes will be lost if the page is refreshed.'); }
}

function commit() { save(); render(); }

const flash = text => { $('msg').textContent = text; };
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const seatOf = name => state.game.onCourt.find(c => c.name === name);
const player = name => state.players.find(p => p.name === name);
const teamFull = team => state.game.onCourt.filter(c => c.team === team).length >= TEAM_SIZE;
const score = team => Queue.played(state.game).filter(c => c.team === team).reduce((t, c) => t + c.points, 0);
const remaining = () => (state.game.endsAt ? Math.max(0, state.game.endsAt - Date.now()) : state.game.remainingMs);
const clockText = ms => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
// Fill, Pick, Sit out and Remove lock once the clock has started or anyone has scored.
const locked = () => state.game.started || Queue.played(state.game).some(c => c.points > 0);
const ready = () => {
  const court = state.game.onCourt;
  return court.length > 0 && court.every(c => c.team) && ['home', 'away'].every(t => court.some(c => c.team === t));
};
// Every called player is on a team: a new one joins the side with fewer players (Home on a tie).
// On the queue diagram, drag them onto the other team to switch.
function seatTeams(g = state.game) {
  const n = t => g.onCourt.filter(c => c.team === t).length;
  for (const c of g.onCourt) if (!c.team) c.team = n('away') < n('home') ? 'away' : 'home';
}
const cleanName = Names.clean;
const profileOf = name => profiles.get(name.toLowerCase());
const playerNamed = name => state.players.find(p => p.name.toLowerCase() === name.toLowerCase());
const avgText = name => {
  if (!profiles.size) return '';
  const p = profileOf(name);
  return p?.games ? `AVG ${p.avg.toFixed(1)}` : 'NEW';
};
const localDate = ms => new Date(ms).toLocaleDateString('en-CA'); // YYYY-MM-DD
const btn = (action, name, label, { arg = '', pressed, cls = 'o s', disabled } = {}) =>
  `<button class="btn ${cls}" data-action="${action}" data-name="${esc(name)}" data-arg="${arg}"` +
  `${pressed === undefined ? '' : ` aria-pressed="${pressed}"`}${disabled ? ' disabled' : ''}>${label}</button>`;

// ---- tabs: the island. A tab hides every panel but its own and scrolls to the top ----

const TABS = ['home', 'checkin', 'queue', 'board', 'leaders'];
const island = $('island'), thumb = island.querySelector('.island-thumb');
const tabs = [...island.querySelectorAll('[role="tab"]')];
let active = 'home';

function place() {
  const b = island.querySelector('[aria-selected="true"]');
  if (!b) return;
  thumb.style.width = b.offsetWidth + 'px';
  thumb.style.transform = `translateX(${b.offsetLeft}px)`;
}
function show(name) {
  if (!TABS.includes(name)) name = 'home';
  const changed = name !== active;
  active = name;
  tabs.forEach(t => { const on = t.dataset.tab === name; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; });
  TABS.forEach(id => { $(id).hidden = id !== name; });
  place();
  island.querySelector('[aria-selected="true"]').scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (changed) window.scrollTo(0, 0);
  if (name === 'checkin') renderTonight();
}
const route = () => show(decodeURIComponent(location.hash.slice(1)));
function go(name) { try { history.replaceState(null, '', '#' + name); } catch {} show(name); }

tabs.forEach(t => {
  t.addEventListener('click', () => go(t.dataset.tab));
  t.addEventListener('keydown', e => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const i = tabs.indexOf(t), n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    n.focus();
    n.click();
  });
});
document.querySelectorAll('a.btn[href^="#"]').forEach(a => {
  a.addEventListener('click', e => { e.preventDefault(); go(a.getAttribute('href').slice(1)); });
});
window.addEventListener('hashchange', route);
window.addEventListener('resize', place);
document.fonts?.ready.then(place);

// ---- database: D1 behind the Worker; the app keeps working without it ----

class Rejected extends Error {}
class Locked extends Error {}

async function api(path, body) {
  if (location.protocol === 'file:') throw new Error('opened as a file');
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${stored(PASS_KEY) || ''}` },
  });
  if (res.status === 401) { db = 'locked'; askPasscode(); throw new Locked(); }
  if (res.status === 400) throw new Rejected((await res.json()).error);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const list = await res.json();
  profiles = new Map(list.map(p => [p.name.toLowerCase(), p]));
  try { localStorage.setItem(PROFILES_KEY, JSON.stringify(list)); } catch {}
  if (body !== undefined || db !== 'locked') db = 'online'; // a read alone doesn't prove the passcode works
}

// Writes need the organizer passcode, entered once per laptop and kept in this browser.
function askPasscode() {
  const dlg = $('passDlg');
  if (dlg.open) return;
  dlg.returnValue = '';
  $('passText').value = '';
  dlg.showModal();
}

// Finished games wait in state.unsynced (saved in this browser) until the database has them.
// One sync at a time: an overlapping one could send the same game twice or shift the wrong one.
let syncing = false, syncAgain = false;
async function sync() {
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    await api('/api/profiles');
    while (state.unsynced.length) {
      try { await api('/api/results', state.unsynced[0]); }
      catch (e) { if (!(e instanceof Rejected)) throw e; flash(`The database rejected a game: ${e.message}`); }
      state.unsynced.shift();
      save();
    }
  } catch (e) {
    if (!(e instanceof Rejected || e instanceof Locked)) db = 'offline';
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; sync(); }
  }
  render();
}

function checkIn(raw) {
  const typed = cleanName(raw);
  if (!typed) return;
  const p = playerNamed(typed);
  if (p) return flash(p.present ? `${p.name} is already checked in.` : `${p.name} is done for the night.`);
  const name = profileOf(typed)?.name ?? typed; // keep the database's spelling
  state.players.push({ name, games: 0, readyAt: Date.now(), present: true, totalPoints: 0 });
  flash(`${name} checked in.`);
  commit();
}

// ---- name autosuggest (check-in and tonight's list) ----

let needsChoice = []; // pasted names that match several players: { query, choices }

const onList = name => state.expected.some(n => n.toLowerCase() === name.toLowerCase());
function addToList(name) { if (name && !onList(name)) state.expected.push(name); }
// New names reach the database as soon as they're on the list; offline is fine, games add them later.
const saveList = () => { if (state.expected.length) api('/api/players', { names: state.expected }).catch(() => {}).then(render); };

// Everyone the app knows: the database, tonight's list and tonight's players.
function knownPeople() {
  const people = new Map([...profiles.values()].map(p => [p.name.toLowerCase(), { ...p }]));
  for (const name of [...state.expected, ...state.players.map(p => p.name)]) {
    const key = name.toLowerCase();
    const p = playerNamed(name);
    people.set(key, { ...(people.get(key) ?? { name, games: 0 }), priority: onList(name), here: !!p?.present, done: p?.present === false });
  }
  return [...people.values()];
}

// An ARIA combobox over Names.suggest. pick(name) gets a resolved full name;
// say(text) explains why Enter did nothing.
function autosuggest(input, list, pick, say) {
  let items = [], hi = -1;
  const close = () => {
    list.hidden = true;
    hi = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  };
  const draw = () => {
    const q = input.value, people = knownPeople();
    items = Names.suggest(q, people).map(p => ({
      name: p.name,
      label: [p.here && 'CHECKED IN', p.done && 'DONE', p.priority && 'TONIGHT', avgText(p.name)].filter(Boolean).join(' · '),
    }));
    if (cleanName(q) && !Names.resolve(q, people).name) items.push({ name: cleanName(q), label: 'NEW PLAYER' });
    hi = Math.min(hi, items.length - 1);
    list.innerHTML = items.map((it, i) => `<li role="option" id="${list.id}-${i}" data-i="${i}" aria-selected="${i === hi}">
        <b>${esc(it.name)}</b><span class="mono">${it.label}</span></li>`).join('');
    list.hidden = !items.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
    if (hi >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${hi}`);
    else input.removeAttribute('aria-activedescendant');
  };
  const choose = name => { input.value = ''; close(); say(''); pick(name); };
  const enter = () => {
    if (hi >= 0) return choose(items[hi].name);
    const r = Names.resolve(input.value, knownPeople());
    if (r.name) return choose(r.name);
    if (r.choices) { draw(); return say(`${r.choices.length} players are called ${r.choices[0].split(' ')[0]}. Pick one.`); }
    if (!r.fresh) return;
    if (items.length > 1) { draw(); return say('Pick a suggestion, or New player to add someone new.'); }
    choose(r.fresh);
  };
  input.addEventListener('input', () => { hi = -1; say(''); draw(); });
  input.addEventListener('blur', close);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (list.hidden) draw();
      if (!items.length) return;
      hi = e.key === 'ArrowDown' ? (hi + 1) % items.length : hi <= 0 ? items.length - 1 : hi - 1;
      draw();
    } else if (e.key === 'Escape') close();
    else if (e.key === 'Enter') { e.preventDefault(); enter(); }
  });
  list.addEventListener('mousedown', e => {
    const li = e.target.closest('[data-i]');
    if (li) { e.preventDefault(); choose(items[li.dataset.i].name); }
  });
  return { enter };
}

// ---- actions (each click handler; return false to skip saving) ----

const actions = {
  fill() { if (locked()) return false; Queue.fill(state.players, state.game, SPOTS); seatTeams(); },
  pick(name) { if (locked()) return false; Queue.pick(state.game, name, SPOTS); seatTeams(); },
  sitOut(name) { if (locked()) return false; Queue.sitOut(state.game, name); },
  remove(name) { if (locked()) return false; Queue.remove(state.game, name); },
  done: name => { player(name).present = false; }, // no confirm: Undo puts them back
  undoDone: name => { player(name).present = true; },
  leaderMode(_, mode) { leaderMode = mode; keepFocus(renderQueue); return false; }, // a view choice, not saved
  checkIn: name => { checkIn(name); return false; },
  removeName: name => { state.expected = state.expected.filter(n => n !== name); },
  choose: (name, query) => { needsChoice = needsChoice.filter(c => c.query !== query); addToList(name); saveList(); },
  pasteList() {
    $('pasteDlg').returnValue = '';
    $('pasteDlg').showModal();
    return false;
  },
  points: (name, n) => { const c = seatOf(name); c.points = Math.max(0, c.points + Number(n)); },

  startPause() {
    const g = state.game;
    if (g.endsAt) { g.remainingMs = remaining(); g.endsAt = null; }
    else if (ready() && g.remainingMs > 0) { g.endsAt = Date.now() + g.remainingMs; g.started = true; }
  },

  resetClock() {
    if (!confirm(`Reset the clock to ${GAME_MINUTES}:00?`)) return false;
    Object.assign(state.game, { remainingMs: GAME_MS, endsAt: null, started: false });
  },

  endGame() {
    const g = state.game;
    if (!g.onCourt.length) return false;
    if (!confirm(`End game ${g.number}? ${g.homeName} ${score('home')}, ${g.awayName} ${score('away')}.`)) return false;
    const lineup = nextLineup(Date.now()); // before the game is counted, as Up next showed it
    Queue.endGame(state.players, g, Date.now());
    state.unsynced.push({
      session: state.startedAt, date: localDate(state.startedAt), game: g.number,
      rows: Queue.played(g).map(c => ({ name: c.name, points: c.points })),
    });
    state.game = newGame(g.number + 1);
    state.game.onCourt = lineup.map(x => ({ ...Queue.seat(x.name), team: x.team })); // Up next takes the court
    setTimeout(sync);
    if (document.fullscreenElement) document.exitFullscreen();
    go('queue');
  },

  goTab(_, tab) { go(tab); return false; },
  // Standby on the TV: the logo and Hexagames, full screen. A click on it (or Esc) comes back.
  standby() {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('standby').requestFullscreen?.();
    return false;
  },

  signOut() {
    if (confirm('Sign out on this device? Opening the app again will need the organizer passcode.')) signOut();
    return false;
  },

  newSession() {
    if (!confirm('Start a new session? This clears tonight\'s players, list and points. The database keeps every result.')) return false;
    state = { ...newSession(), unsynced: state.unsynced };
    needsChoice = [];
  },

  // From the queue diagram: a waiting player in for someone on court. No confirm: swapping back undoes it.
  sub: (outName, inName) => { Queue.sub(state.game, outName, inName, locked()); },

  flip() { state.flipped = !state.flipped; }, // Switch sides: which team shows on the left

  fullscreen(_, arg) {
    if (document.fullscreenElement) document.exitFullscreen();
    else $(arg || 'board').requestFullscreen?.();
    return false;
  },
};

document.addEventListener('click', e => {
  try { audio ??= new AudioContext(); } catch {}
  const b = e.target.closest('[data-action]');
  if (b && actions[b.dataset.action](b.dataset.name, b.dataset.arg) !== false) commit();
});

autosuggest($('listAdd'), $('listSug'), name => {
  const p = playerNamed(name);
  if (p) return flash(p.present ? `${p.name} is already checked in.` : `${p.name} is done for the night.`);
  if (onList(name)) return flash(`${name} is already on the list.`);
  addToList(name);
  commit();
  saveList();
}, flash);

// Paste: each line resolves like typing does; names shared by several players wait for a choice.
$('pasteDlg').addEventListener('close', () => {
  if ($('pasteDlg').returnValue !== 'add') return;
  const people = knownPeople();
  for (const line of $('pasteText').value.split('\n')) {
    const r = Names.resolve(line, people);
    if (r.name || r.fresh) addToList(r.name || r.fresh);
    else if (r.choices && !needsChoice.some(c => Names.norm(c.query) === Names.norm(line))) {
      needsChoice.push({ query: cleanName(line), choices: r.choices });
    }
  }
  $('pasteText').value = '';
  commit();
  saveList();
});

for (const t of ['home', 'away']) {
  $(t + 'Name').oninput = e => {
    state.game[t + 'Name'] = e.target.value || (t === 'home' ? 'Home' : 'Away');
    save();
    renderQueue();
    renderBoard();
  };
}

document.addEventListener('keydown', e => {
  if (e.code !== 'Space' || active !== 'board' || ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
  e.preventDefault();
  actions.startPause();
  commit();
});

// ---- rendering ----

// Re-rendering rebuilds the buttons; put keyboard focus back on the same one.
function keepFocus(draw) {
  const d = document.activeElement?.dataset;
  draw();
  if (!d?.action) return;
  const at = k => `[data-${k}="${CSS.escape(d[k] ?? '')}"]`;
  document.querySelector(`[data-action="${CSS.escape(d.action)}"]${at('name')}${at('arg')}`)?.focus();
}

function render() {
  keepFocus(() => {
    renderQueue();
    renderBoard();
    renderClock();
    renderTonight();
  });
}

function renderQueue() {
  const order = Queue.waitingOrder(state.players, state.game);
  const now = Date.now();

  // The ranked figure is the big one; per game needs MIN_RANKED_GAMES to get a rank.
  const perGame = leaderMode === 'perGame';
  $('leaderIntro').textContent = perGame
    ? `Tonight's points per game. Players need ${MIN_RANKED_GAMES} games to be ranked. Avg is their average across every week.`
    : 'Tonight\'s total points. Avg is each player\'s average across every week.';
  $('leaderMode').innerHTML = [['total', 'Total points'], ['perGame', 'Per game']]
    .map(([m, label]) => btn('leaderMode', '', label, { arg: m, pressed: leaderMode === m, cls: leaderMode === m ? 's' : 'o s' })).join('');
  const big = on => `r ${on ? 'pts' : 'mono'}`;
  // Podium for ranks 1 to 3 (ties share it); two tables side by side past 12 rows so about 30
  // fit on one screen; players with no games yet collapse into one line under the tables.
  const rows = Queue.leaderboard(state.players, leaderMode, MIN_RANKED_GAMES);
  const played = rows.filter(r => r.player.games), notYet = rows.filter(r => !r.player.games);
  const avgNum = name => (profileOf(name)?.games ? profileOf(name).avg.toFixed(1) : 'New');
  const row = ({ player: p, perGame: pg, rank }) => `<tr class="${!rank ? 'un' : rank <= 3 ? `top p${rank}` : ''}">
      <td class="n">${rank ?? ''}</td><td class="who"><b title="${esc(p.name)}">${esc(p.name)}</b></td>
      <td class="r mono">${p.games}</td><td class="${big(!perGame)}">${p.totalPoints}</td>
      <td class="${big(perGame)}">${pg === null ? '' : pg.toFixed(1)}</td><td class="r mono avg hide-sm">${avgNum(p.name)}</td></tr>`;
  const table = list => `<div class="tw"><table><thead><tr><th>#</th><th>Player</th><th class="r">Games</th><th class="r">Points</th>
      <th class="r">Per game</th><th class="r avg hide-sm">Avg</th></tr></thead><tbody>${list.map(row).join('')}</tbody></table></div>`;
  const split = played.length > 12, half = Math.ceil(played.length / 2);
  $('leaderBoard').className = `wide lb${split ? ' split' : ''}${profiles.size ? '' : ' noavg'}`;
  $('leaderBoard').innerHTML = !rows.length ? '<p class="empty">No players yet.</p>'
    : (!played.length ? '<p class="empty">No games played yet.</p>'
      : split ? table(played.slice(0, half)) + table(played.slice(half)) : table(played))
      + (notYet.length ? `<p class="rest">Not played yet: ${notYet.map(r => esc(r.player.name)).join(', ')}</p>` : '');

  renderMap(order, now);
  renderHome();
}

// The queue as a diagram for the TV: on court, then up next, then everyone else by games played.
// First names read from across the gym; a last initial only when tonight has two of that first name.
const firstName = name => name.split(' ')[0];
function shortName(name) {
  const twin = state.players.some(p => p.name !== name && firstName(p.name).toLowerCase() === firstName(name).toLowerCase());
  return twin && name.includes(' ') ? `${firstName(name)} ${name.split(' ').at(-1)[0]}.` : firstName(name);
}
// The next game's lineup, already in teams: the fairness order for the following game
// (Queue.nextGame), split Home/Away, with the organizer's edits from the diagram kept in
// game.plan. Players who left are dropped and the next in fairness order take their spots.
// End game seats this lineup on court.
function nextLineup(now) {
  const g = state.game, fair = Queue.nextGame(state.players, g, SPOTS, now).map(p => p.name);
  const list = (g.plan ?? []).filter(x => player(x.name)?.present).map(x => ({ ...x }));
  for (const name of fair) if (list.length < SPOTS && !list.some(x => x.name === name)) list.push({ name, team: null });
  const n = t => list.filter(x => x.team === t).length;
  for (const x of list) if (!x.team) x.team = n('away') < n('home') ? 'away' : 'home';
  return list;
}
// An edit to Up next freezes the lineup as shown, then changes it.
function editPlan(fn) { const g = state.game; g.plan = nextLineup(Date.now()); fn(g.plan); commit(); }
const planSwap = (out, inn) => editPlan(l => { l.find(x => x.name === out).name = inn; }); // a waiting player in
const planTeams = (a, b) => editPlan(l => { const x = l.find(y => y.name === a), y = l.find(z => z.name === b); [x.team, y.team] = [y.team, x.team]; });
const planMove = (name, team) => editPlan(l => { if (l.filter(x => x.team === team).length < TEAM_SIZE) l.find(x => x.name === name).team = team; });

// Home: one button for the next step of the night (Check in players, Fill the court,
// Start game N, Back to game N), next to Standby on TV.
function renderHome() {
  const g = state.game, present = state.players.some(p => p.present), started = g.started || !!g.endsAt;
  $('homeNext').textContent = !present ? 'Check in players'
    : started ? `Back to game ${g.number}` : ready() ? `Start game ${g.number}` : 'Fill the court';
  $('homeNext').dataset.arg = !present ? 'checkin' : started || ready() ? 'board' : 'queue';
}

// The Queue tab is this diagram, for the TV and the organizer alike: On court (Home, Away), then
// Up next, then everyone else waiting by games played, then done for the night. While the court
// has open spots, Up next is who Fill calls now; once it is full, it is the next game's lineup in
// its own Home and Away (nextLineup).
// Click a box to select it and its buttons appear inside it: on court, Sit out and Remove;
// waiting, Pick and Done; done, Undo. Clicking a second box pairs them: a waiting player and
// someone on court (a sub), a waiting player and someone in the lineup (a replacement), or two
// players on opposite teams (they swap). Or drag one box onto the other. Dragging onto a team's
// area moves a player there (calling them, if waiting); onto the waiting side undoes a call.
// Teams change only this way. Nothing asks to confirm: each action has a way back.
let sel = null; // the selected box: { name, src }, src being court, next, wait or done
function renderMap(order, now) {
  const g = state.game, lock = locked(), open = !lock && g.onCourt.length < SPOTS, full = g.onCourt.length >= SPOTS;
  const passed = new Set(lock ? [] : Queue.passedOver(state.players, g));
  if (sel && !player(sel.name)) sel = null;
  const acts = (name, src) => {
    const p = player(name), seat = seatOf(name);
    if (!p.present) return btn('undoDone', name, 'Undo');
    if (src === 'next') return (seat ? '' : btn('done', name, 'Done')) + '<small class="hint">click or drag a waiting player here to swap them in</small>';
    if (seat) return (lock ? '' : btn('sitOut', name, 'Sit out') + btn('remove', name, 'Remove')) + '<small class="hint">drag onto the other team to switch</small>';
    return (open ? btn('pick', name, 'Pick', { cls: 's' }) : '') + btn('done', name, 'Done')
      + (g.onCourt.length ? `<small class="hint">or click someone on court${full ? ' or up next' : ''} to swap in</small>` : '');
  };
  const node = (name, src, cls = '') => {
    const p = player(name), on = !!seatOf(name), picked = sel?.name === name && sel.src === src;
    const notes = [plural(p.games, 'game')];
    if (!on && p.present) notes.push(`${Math.floor((now - p.readyAt) / 60000)} min`); // on court: not waiting
    if (g.satOut.includes(name)) notes.push('sitting out');
    if (passed.has(name)) notes.push('passed over');
    return `<div class="qn${cls}${picked ? ' picked' : ''}" data-p="${esc(name)}" data-src="${src}"${p.present ? ' draggable="true"' : ''}
      tabindex="0" role="button" aria-pressed="${picked}" title="${esc(name)}"><b>${esc(shortName(name))}</b><small>${notes.join(' · ')}</small>${
      picked ? `<span class="qacts">${acts(name, src)}</span>` : ''}</div>`;
  };
  const group = (label, names, src, cls = '', mark = '', zone = '') => names.length || zone
    ? `<div class="qgrp"${zone ? ` data-zone="${zone}"` : ''}><p class="grp">${mark}${esc(label)}</p>${names.length
      ? `<div class="qnodes">${names.map(n => node(n, src, cls)).join('')}</div>` : '<p class="zone">Drag players here</p>'}</div>` : '';
  const col = (cls, head, body, empty, zone = '') => `<div class="qcol ${cls}"${zone ? ` data-zone="${zone}"` : ''}>
      <div class="colhead">${head}</div>${body || `<p class="empty">${empty}</p>`}</div>`;
  const arrow = '<span class="qarrow" aria-hidden="true">&rarr;</span>';
  const teamLabel = (t, n) => `${g[t + 'Name']} · ${n} of ${TEAM_SIZE}`;

  const team = t => g.onCourt.filter(c => c.team === t).map(c => c.name);
  const court = ['home', 'away'].map(t => group(teamLabel(t, team(t).length), team(t), 'court', ` on ${t}`, mk(t), t)).join('');
  const fill = open && Queue.nextInLine(state.players, g, SPOTS).length ? btn('fill', '', 'Fill open spots', { cls: 's' }) : '';

  // Up next: who Fill calls now (open spots), or the next game's lineup in teams (court full).
  const lineup = full ? nextLineup(now) : [];
  const nextNames = full ? lineup.map(x => x.name) : Queue.nextInLine(state.players, g, SPOTS).map(p => p.name);
  const upnext = full
    ? ['home', 'away'].map(t => { const names = lineup.filter(x => x.team === t).map(x => x.name);
      return group(teamLabel(t, names.length), names, 'next', ` nx ${t}`, mk(t), 'next-' + t); }).join('')
    : group(plural(nextNames.length, 'player'), nextNames, 'wait');
  const nextSet = new Set(nextNames);
  const tiers = new Map();
  for (const p of order) if (!nextSet.has(p.name)) tiers.set(p.games, [...(tiers.get(p.games) ?? []), p.name]);
  const waiting = [...tiers].sort((a, b) => a[0] - b[0]).map(([n, names]) => group(plural(n, 'game'), names, 'wait')).join('')
    + group('Done for the night', state.players.filter(p => !p.present).map(p => p.name), 'done', ' out');

  $('qmap').innerHTML = col('court', `<p class="col">On court · Game ${g.number}</p>${fill}`, court, '') + arrow
    + col('next', `<p class="col">${full ? `Up next · Game ${g.number + 1}` : 'Up next · fills open spots'}</p>`, upnext, 'Nobody to call.', full ? '' : 'line') + arrow
    + col('wait', `<p class="col">Waiting</p>${btn('fullscreen', '', 'Full screen', { arg: 'qmap' })}`, waiting, 'Nobody waiting.', 'line');
}

const qmap = $('qmap');
// Drag events can target the text inside a box (Firefox), so look up from its element.
const hit = (e, s) => (e.target.nodeType === 1 ? e.target : e.target.parentElement)?.closest(s);
const run = fn => { fn(); commit(); };
const teamIn = (src, name) => (src === 'court' ? seatOf(name)?.team : nextLineup(Date.now()).find(x => x.name === name)?.team);
// Two boxes, one after the other (drag one onto the other, or click both): sub, replace or swap.
// Returns false when the pair means nothing, so a drop can fall back to the area underneath.
function pair(a, aSrc, b, bSrc) {
  if (a === b || !player(a)?.present || !player(b)?.present) return false;
  const waits = src => src === 'wait';
  if (waits(aSrc) !== waits(bSrc)) { // a waiting player and someone on court or in the lineup
    const [w, other, oSrc] = waits(aSrc) ? [a, b, bSrc] : [b, a, aSrc];
    if (oSrc === 'court' && !seatOf(w)) return run(() => actions.sub(other, w));
    if (oSrc === 'next' && !nextLineup(Date.now()).some(x => x.name === w)) return planSwap(other, w);
    return false;
  }
  if (aSrc !== bSrc || waits(aSrc)) return false;
  const ta = teamIn(aSrc, a), tb = teamIn(bSrc, b);
  if (!ta || !tb || ta === tb) return false;
  if (aSrc === 'court') return run(() => { [seatOf(a).team, seatOf(b).team] = [tb, ta]; }); // swap sides
  return planTeams(a, b);
}
// Drop a player (from box src) on a box or an area of the diagram.
function dropOn(name, src, t) {
  if (!player(name)?.present) return;
  if (t.dataset.p && pair(name, src, t.dataset.p, t.dataset.src) !== false) return;
  const zone = (t.dataset.p ? t.closest('[data-zone]') : t)?.dataset.zone;
  if (!zone) return;
  if (zone.startsWith('next-')) { if (src === 'next') planMove(name, zone.slice(5)); return; } // lineup: switch team
  const seat = seatOf(name);
  if (zone === 'line') { if (seat && src === 'court' && actions.remove(name) !== false) commit(); return; } // back in line
  if (src === 'next') return; // lineup players reach the court when the game ends
  if (seat?.team !== zone && teamFull(zone)) return;
  if (!seat) { if (actions.pick(name) === false || !seatOf(name)) return; } // onto a team: call them
  run(() => { seatOf(name).team = zone; });
}
qmap.addEventListener('dragstart', e => {
  const n = hit(e, '[data-p][draggable="true"]');
  if (n) { e.dataTransfer.setData('text/plain', `${n.dataset.src}:${n.dataset.p}`); e.dataTransfer.effectAllowed = 'move'; }
});
qmap.addEventListener('dragover', e => {
  const t = hit(e, '[data-src="court"],[data-src="next"]') || hit(e, '[data-zone]');
  if (!t) return;
  e.preventDefault();
  qmap.querySelectorAll('.drop').forEach(x => x !== t && x.classList.remove('drop'));
  t.classList.add('drop');
});
qmap.addEventListener('dragleave', e => { if (!qmap.contains(e.relatedTarget)) qmap.querySelectorAll('.drop').forEach(x => x.classList.remove('drop')); });
qmap.addEventListener('drop', e => {
  const t = hit(e, '[data-p]') || hit(e, '[data-zone]'), data = e.dataTransfer.getData('text/plain');
  qmap.querySelectorAll('.drop').forEach(x => x.classList.remove('drop'));
  if (!t || !data.includes(':')) return;
  e.preventDefault();
  const i = data.indexOf(':');
  sel = null;
  dropOn(data.slice(i + 1), data.slice(0, i), t);
});
qmap.addEventListener('click', e => {
  if (hit(e, '[data-action]')) return; // a box's own button: the document handler runs it
  const box = hit(e, '[data-p]');
  if (box) choose(box.dataset.p, box.dataset.src);
  else if (sel) { sel = null; renderQueue(); } // a click on empty space clears
});
// Select a box; with one already selected, pair the two (see pair).
function choose(name, src) {
  if (sel && pair(sel.name, sel.src, name, src) !== false) { sel = null; return renderQueue(); }
  sel = sel?.name === name && sel.src === src ? null : { name, src };
  renderQueue();
  qmap.querySelector(`[data-p="${CSS.escape(name)}"][data-src="${src}"]`)?.focus();
}
qmap.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-p]')) { e.preventDefault(); e.target.click(); }
  else if (e.key === 'Escape' && sel) { sel = null; renderQueue(); }
});

// Check in layout: how many rows a column holds, and which groups stack in one column. Columns
// hold as many rows as fit between the top of the list and the bottom of the screen; a group that
// fits in one column stacks under the previous one when both fit the height. If the columns still
// don't fit across the page, columns get longer (the page then scrolls down, never sideways).
// A phone shows each group as one full-width column.
function rosterLayout(ns) {
  const r = $('roster'), most = Math.max(1, ...ns), one = { rows: most, stacks: ns.map((_, i) => [i]) };
  if ($('checkin').hidden || r.clientWidth < 600) return one; // laid out again when the tab shows
  const H = innerHeight - (r.getBoundingClientRect().top + scrollY) - 24, STACK_GAP = 24;
  const pack = rows => {
    const stacks = [];
    let used = Infinity; // height used in the last stack, when it can take more
    ns.forEach((n, i) => {
      const h = HEAD_H + Math.min(n, rows) * ROW_H;
      if (n <= rows && used + STACK_GAP + h <= H) { stacks.at(-1).push(i); used += STACK_GAP + h; }
      else { stacks.push([i]); used = n <= rows ? h : Infinity; }
    });
    const width = stacks.reduce((w, st) => w + Math.max(...st.map(i => Math.ceil(ns[i] / rows))) * COL_W, 0) + GROUP_GAP * (stacks.length - 1);
    return { rows, stacks, width };
  };
  for (let rows = Math.max(4, Math.floor((H - HEAD_H) / ROW_H)); rows < most; rows++) {
    const l = pack(rows);
    if (l.width <= r.clientWidth) return l;
  }
  return pack(most);
}
window.addEventListener('resize', () => renderTonight());

const tag = name => (avgText(name) ? ` · ${avgText(name)}` : '');
// Team marker for labels: a filled square for Home, an outlined one for Away.
const mk = team => `<i class="mk ${team}" aria-hidden="true"></i>`;

// Check in: tonight's list and everyone here, as grouped lists in the Apple style: one group per
// status (Home, Away, Here, To arrive, Done) with a small header and count, quiet one-line rows in
// rounded cards, color only in the headers. Each group fills down to the bottom of the screen,
// then starts another column; short groups stack (Home over Away), and groups never mix. A row shows its details
// (games tonight) until it is hovered or focused, then its button: Done, Undo, or the x that takes
// a name off the list. Check in, the main action, always shows; touch screens show every button.
const ROW_H = 40, HEAD_H = 30, COL_W = 220, GROUP_GAP = 28; // px: .rrow height, .sech height, .rows width + 8px gap, .roster gap
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); // Test 2 before Test 10
function renderTonight() {
  const people = new Map(state.expected.map(n => [n.toLowerCase(), { n, name: profileOf(n)?.name ?? n }]));
  for (const p of state.players) people.set(p.name.toLowerCase(), { n: p.name, name: p.name });
  const g = state.game, groups = { home: [], away: [], here: [], arrive: [], done: [] };
  for (const x of people.values()) {
    const p = playerNamed(x.name), seat = p && seatOf(p.name);
    groups[!p ? 'arrive' : !p.present ? 'done' : seat ? seat.team ?? 'home' : 'here'].push({ ...x, p });
  }
  const row = ({ n, name, p }, key) => {
    const pr = profileOf(name);
    const record = !profiles.size ? '' : pr?.games ? ` · ${plural(pr.games, 'game')} · AVG ${pr.avg.toFixed(1)}` : ' · First game';
    const games = p ? `<small>${plural(p.games, 'game')}</small>` : '';
    const trail = key === 'arrive'
      ? btn('checkIn', name, 'Check in', { cls: 's' }) + `<button type="button" class="xbtn" data-action="removeName"
        data-name="${esc(n)}" data-arg="" aria-label="Remove ${esc(name)} from tonight's list">&times;</button>`
      : key === 'here' ? games + btn('done', name, 'Done') : key === 'done' ? games + btn('undoDone', name, 'Undo') : games;
    return `<div class="rrow" title="${esc(name)}${p ? ` · ${plural(p.games, 'game')} tonight` : ''}${record}"><b>${esc(name)}</b>${trail}</div>`;
  };
  const heads = { home: [mk('home'), g.homeName], away: [mk('away'), g.awayName], here: ['<i class="sdot" aria-hidden="true"></i>', 'Here'],
    arrive: ['', 'To arrive'], done: ['', 'Done for the night'] };
  const keys = Object.keys(groups).filter(k => groups[k].length);
  const { rows, stacks } = rosterLayout(keys.map(k => groups[k].length));
  const sec = i => {
    const k = keys[i], list = groups[k].sort((a, b) => byName(a.name, b.name)), cols = [];
    for (let j = 0; j < list.length; j += rows) cols.push(`<div class="rows">${list.slice(j, j + rows).map(x => row(x, k)).join('')}</div>`);
    return `<div class="sec s-${k}"><p class="sech">${heads[k][0]}${esc(heads[k][1])}<span>${list.length}</span></p><div class="cols">${cols.join('')}</div></div>`;
  };
  $('roster').innerHTML = stacks.map(st => `<div class="stack">${st.map(sec).join('')}</div>`).join('')
    || '<p class="empty">Nobody on the list yet. Add players above, or paste this week\'s list.</p>';

  $('choices').innerHTML = needsChoice.map(c => `<div class="notice">
      <b>${esc(c.query)} matches ${c.choices.length} players. Which one is coming?</b>
      <div class="btns">${[...c.choices.map(n => btn('choose', n, esc(n), { arg: esc(c.query) })),
        btn('choose', c.query, 'New player', { arg: esc(c.query) })].join('')}</div>
    </div>`).join('');

  const pending = state.unsynced.length;
  const offline = db === 'offline';
  const dot = $('dbDot');
  const label = `Database ${db === 'locked' ? 'needs the organizer passcode' : db}${pending ? ` · ${plural(pending, 'game')} not saved yet` : ''}`;
  dot.className = `island-db ${{ online: 'on', offline: 'off', locked: 'off' }[db] ?? ''}`;
  dot.setAttribute('aria-label', db === 'locked' ? `${label}. Enter passcode` : offline ? `${label}. Try again` : label);
  dot.title = offline ? `${label}. Games are kept on this laptop until the connection is back. Click to try again.`
    : db === 'locked' ? `${label}. Click to enter it.` : `${label} · ${plural(profiles.size, 'player')} on file`;
}

function renderBoard() {
  const g = state.game;
  for (const t of ['home', 'away']) {
    const team = g.onCourt.filter(c => c.team === t);
    $(t + 'Score').textContent = score(t);
    if (document.activeElement !== $(t + 'Name')) $(t + 'Name').value = g[t + 'Name'];
    $(t + 'Lbl').textContent = g[t + 'Name'];
    $(t + 'Count').textContent = plural(team.length, 'player').toUpperCase();
    $(t + 'Players').innerHTML = team.map(c => `<div class="pl">
        <span><b>${esc(c.name)}</b><small class="mono">${avgText(c.name)}</small></span><span class="pts">${c.points}</span>
        <span class="pt">${[1, 2, 3, -1].map(n => btn('points', c.name, n > 0 ? `+${n}` : '&minus;1', { arg: n, cls: 'o' })).join('')}</span>
      </div>`).join('') || '<p class="empty">No players on this team.</p>';
  }
  $('boardGame').textContent = `Game ${g.number}`;
  $('board').classList.toggle('flip', !!state.flipped);
  $('flipBtn').setAttribute('aria-pressed', !!state.flipped);
  $('boardHint').textContent = ready() ? '' : 'On the Queue tab, fill the spots and set each player to a team.';
}

function renderClock() {
  const g = state.game, ms = remaining();
  $('clock').textContent = clockText(ms);
  $('clock').classList.toggle('low', ms <= 60000);
  $('startBtn').textContent = g.endsAt ? 'Pause' : 'Start';
  $('startBtn').disabled = !g.endsAt && (!ready() || ms === 0);
  $('islandClock').textContent = `Game ${g.number} · ${g.endsAt || g.started ? clockText(ms) : 'Not started'}`;
  $('islandClock').classList.toggle('on', !!g.endsAt);
  // The TV standby: the wall clock and today's date.
  const now = new Date();
  $('sbTime').textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
  $('sbDate').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

// ponytail: plain oscillator tone; swap for a recorded horn if the gym needs louder
function buzz() {
  if (!audio) return;
  const tone = audio.createOscillator(), volume = audio.createGain();
  tone.type = 'square';
  tone.frequency.value = 440;
  volume.gain.value = 0.3;
  tone.connect(volume).connect(audio.destination);
  tone.start();
  tone.stop(audio.currentTime + 1.5);
}

// The clock is an end timestamp, so it can't drift and survives a refresh.
setInterval(() => {
  const g = state.game;
  if (g.endsAt && g.endsAt <= Date.now()) {
    Object.assign(g, { endsAt: null, remainingMs: 0 });
    buzz();
    commit();
  }
  renderClock();
}, 250);
setInterval(() => keepFocus(renderQueue), 15000); // keep wait times current

// The dot only acts when there is something to do: ask for the passcode when the database
// refused it, retry when offline. Online it just shows its state (hover for details).
$('dbDot').onclick = () => { if (db === 'locked') askPasscode(); else if (db !== 'online') { db = 'connecting'; renderTonight(); sync(); } };
// Enter in the passcode box saves; left to the form it would press Cancel, the first button.
$('passText').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('passDlg').close('save'); } });
$('passDlg').addEventListener('close', () => {
  if ($('passDlg').returnValue !== 'save' || !$('passText').value) return;
  const passcode = $('passText').value;
  try { localStorage.setItem(PASS_KEY, passcode); } catch {}
  $('passText').value = '';
  db = 'connecting';
  // Also renews this device's sign-in, e.g. after the passcode was changed.
  api('/api/login', { passcode }).catch(() => {}).finally(() => { sync(); saveList(); });
});

// Sign out: forget the passcode and the offline copy on this device, then back to the home page.
// Tonight's session stays saved in this browser for whoever signs in next.
async function signOut() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  try { localStorage.removeItem(PASS_KEY); } catch {}
  try { await Promise.all((await caches.keys()).map(k => caches.delete(k))); } catch {}
  location.replace('/');
}

// Keeps the page opening with no connection once it has loaded here (sw.js).
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});

route();
render();
sync();
