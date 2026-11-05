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
      return { expected: [], unsynced: [], startedAt: Date.now(), ...s };
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
  fill() { if (locked()) return false; Queue.fill(state.players, state.game, SPOTS); },
  pick(name) { if (locked()) return false; Queue.pick(state.game, name, SPOTS); },
  sitOut(name) { if (locked()) return false; Queue.sitOut(state.game, name); },
  remove(name) { if (locked()) return false; Queue.remove(state.game, name); },
  team(name, team) {
    const c = seatOf(name);
    if (c.team !== team && teamFull(team)) return false;
    c.team = c.team === team ? null : team;
  },
  done(name) {
    if (!confirm(`Mark ${name} done for the night? They won't be called again.`)) return false;
    player(name).present = false;
  },
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
    Queue.endGame(state.players, g, Date.now());
    state.unsynced.push({
      session: state.startedAt, date: localDate(state.startedAt), game: g.number,
      rows: Queue.played(g).map(c => ({ name: c.name, points: c.points })),
    });
    state.game = newGame(g.number + 1);
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

  // From the queue diagram: drag a waiting player onto someone on court (or click one, then the other).
  sub(outName, inName) {
    subPick = null;
    if (!confirm(`Sub ${inName} in for ${outName}?`)) return false;
    Queue.sub(state.game, outName, inName, locked());
  },

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
  const g = state.game;
  const lock = locked();
  const open = !lock && g.onCourt.length < SPOTS;
  const order = Queue.waitingOrder(state.players, g);
  const next = new Set(Queue.nextInLine(state.players, g, SPOTS).map(p => p.name));
  const passed = new Set(lock ? [] : Queue.passedOver(state.players, g)); // nothing to fix once play starts
  const now = Date.now();

  $('fillBtn').hidden = lock;
  $('fillBtn').disabled = !open || !next.size;

  // Up next: one group per team, so the 5-a-side cap is visible, then anyone without a team.
  // One line per player: name, team toggle, Sit out, remove. Games and average are in the hover text.
  const seat = c => `<div class="qn row" title="${esc(c.name)} · ${plural(player(c.name).games, 'game')} tonight${tag(c.name)}">
      <b>${esc(c.name)}</b><span class="seg">${['home', 'away'].map(t => btn('team', c.name, esc(g[t + 'Name']),
        { arg: t, pressed: c.team === t, cls: c.team === t ? 's' : 'o s', disabled: c.team !== t && teamFull(t) })).join('')}</span>
      ${lock ? '' : btn('sitOut', c.name, 'Sit out') + `<button type="button" class="xbtn" data-action="remove"
        data-name="${esc(c.name)}" data-arg="" aria-label="Remove ${esc(c.name)} from up next">&times;</button>`}</div>`;
  const onTeam = t => g.onCourt.filter(c => c.team === t);
  $('upnext').innerHTML = (boxGroup(`${g.homeName} · ${onTeam('home').length} of ${TEAM_SIZE}`, onTeam('home').map(seat), 'side home', mk('home'))
    + boxGroup(`${g.awayName} · ${onTeam('away').length} of ${TEAM_SIZE}`, onTeam('away').map(seat), 'side away', mk('away'))
    + boxGroup(`No team yet · ${onTeam(null).length}`, onTeam(null).map(seat), 'none'))
    || '<p class="empty">Nobody called yet. Press Fill open spots.</p>';

  // Waiting: fairness order, numbered by place in line. Line 1: place, name, tags; line 2: games, wait, buttons.
  $('waiting').innerHTML = boxGroup(`Waiting · ${order.length}`, order.map((p, i) => {
    const sat = g.satOut.includes(p.name);
    const tags = (next.has(p.name) ? '<span class="stt live">Next</span>' : '')
      + (sat ? '<span class="stt plan">Sitting out</span>' : '')
      + (passed.has(p.name) ? '<span class="stt build">Passed over</span>' : '');
    return `<div class="qn${sat ? ' sat' : ''}" title="${esc(p.name)}${tag(p.name)}">
      <div class="top"><span class="pos">#${i + 1}</span><b>${esc(p.name)}</b>${tags}</div>
      <div class="acts"><small>${plural(p.games, 'game')} · ${Math.floor((now - p.readyAt) / 60000)} min</small>${open ? btn('pick', p.name, 'Pick') : ''}${btn('done', p.name, 'Done')}</div></div>`;
  })) || `<p class="empty">Nobody waiting.${state.players.length ? '' : ' Check people in on the Check in tab.'}</p>`;

  const out = state.players.filter(p => !p.present);
  $('out').innerHTML = boxGroup(`Done for the night · ${out.length}`, out.map(p =>
    `<div class="qn out row" title="${esc(p.name)} · ${plural(p.games, 'game')}"><b>${esc(p.name)}</b>${btn('undoDone', p.name, 'Undo')}</div>`));

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
// Who is up next: before the game fills, who Fill calls now; once it is full, who the following
// game will call (the queue diagram's Up next column).
function upNext(now) {
  const g = state.game;
  return (g.onCourt.length < SPOTS ? Queue.nextInLine(state.players, g, SPOTS) : Queue.nextGame(state.players, g, SPOTS, now)).map(p => p.name);
}

// Home: one button for the next step of the night (Check in players, Fill the court,
// Start game N, Back to game N), next to Standby on TV.
function renderHome() {
  const g = state.game, present = state.players.some(p => p.present), started = g.started || !!g.endsAt;
  $('homeNext').textContent = !present ? 'Check in players'
    : started ? `Back to game ${g.number}` : ready() ? `Start game ${g.number}` : 'Fill the court';
  $('homeNext').dataset.arg = !present ? 'checkin' : started || ready() ? 'board' : 'queue';
}

function renderMap(order, now) {
  const g = state.game, open = g.onCourt.length < SPOTS;
  const node = (name, cls) => {
    const p = player(name);
    const wait = seatOf(name) ? '' : ` · ${Math.floor((now - p.readyAt) / 60000)} min`; // on court: not waiting
    const drag = seatOf(name) ? ` data-seat="${esc(name)}"${subPick ? ' tabindex="0" role="button"' : ''}`
      : ` draggable="true" tabindex="0" role="button" data-sub="${esc(name)}" aria-pressed="${subPick === name}"`;
    return `<div class="qn${cls ? ` ${cls}` : ''}${subPick === name ? ' picked' : ''}"${drag} title="${esc(name)}${seatOf(name) ? '' : ' · drag onto a player on court to sub in'}"><b>${esc(shortName(name))}</b><small>${plural(p.games, 'game')}${wait}</small></div>`;
  };
  const group = (label, names, cls = '', mark = '') => names.length
    ? `<div class="qgrp"><p class="grp">${mark}${esc(label)}</p><div class="qnodes">${names.map(n => node(n, cls)).join('')}</div></div>` : '';
  const col = (cls, label, body, empty) => `<div class="qcol ${cls}"><p class="col">${label}</p>${body || `<p class="empty">${empty}</p>`}</div>`;
  const arrow = '<span class="qarrow" aria-hidden="true">&rarr;</span>';

  const team = t => g.onCourt.filter(c => c.team === t).map(c => c.name);
  const court = group(g.homeName, team('home'), 'on home', mk('home')) + group(g.awayName, team('away'), 'on away', mk('away'))
    + group('No team yet', team(null), 'on none');

  // Before the game fills: who Fill calls now. Once it is full: who the following game will call.
  const next = upNext(now);
  const nextSet = new Set(next);
  const tiers = new Map();
  for (const p of order) if (!nextSet.has(p.name)) tiers.set(p.games, [...(tiers.get(p.games) ?? []), p.name]);
  const waiting = [...tiers].sort((a, b) => a[0] - b[0]).map(([n, names]) => group(plural(n, 'game'), names)).join('');

  $('qmap').innerHTML = col('court', `On court · Game ${g.number}`, court, 'Nobody called yet.') + arrow
    + col('next', open ? 'Up next · fills open spots' : 'Up next · next game', group(plural(next.length, 'player'), next), 'Nobody to call.') + arrow
    + col('wait', 'Waiting', waiting, 'Nobody waiting.');
}

// Substitutions on the diagram. Native drag and drop, plus click-then-click (or Enter) for touch
// and keyboard: subPick is the waiting player chosen first.
let subPick = null;
const qmap = $('qmap');
// Drag events can target the text inside a box (Firefox), so look up from its element.
const hit = (e, sel) => (e.target.nodeType === 1 ? e.target : e.target.parentElement)?.closest(sel);
const doSub = (outName, inName) => { if (actions.sub(outName, inName) !== false) commit(); else renderQueue(); };
qmap.addEventListener('dragstart', e => {
  const n = hit(e, '[data-sub]');
  if (n) { e.dataTransfer.setData('text/plain', n.dataset.sub); e.dataTransfer.effectAllowed = 'move'; }
});
qmap.addEventListener('dragover', e => {
  const t = hit(e, '[data-seat]');
  if (!t) return;
  e.preventDefault();
  qmap.querySelectorAll('.drop').forEach(x => x !== t && x.classList.remove('drop'));
  t.classList.add('drop');
});
qmap.addEventListener('dragleave', e => hit(e, '[data-seat]')?.classList.remove('drop'));
qmap.addEventListener('drop', e => {
  const t = hit(e, '[data-seat]'), name = e.dataTransfer.getData('text/plain');
  if (!t || !name) return;
  e.preventDefault();
  t.classList.remove('drop');
  doSub(t.dataset.seat, name);
});
qmap.addEventListener('click', e => {
  const pick = hit(e, '[data-sub]'), seat = hit(e, '[data-seat]');
  if (pick) { subPick = subPick === pick.dataset.sub ? null : pick.dataset.sub; renderQueue(); qmap.querySelector(`[data-sub="${CSS.escape(pick.dataset.sub)}"]`)?.focus(); }
  else if (seat && subPick) doSub(seat.dataset.seat, subPick);
});
qmap.addEventListener('keydown', e => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-sub],[data-seat]')) { e.preventDefault(); e.target.click(); }
});

const tag = name => (avgText(name) ? ` · ${avgText(name)}` : '');
// A labeled group of player boxes (Check in and Queue); nothing when there are no boxes.
const boxGroup = (label, boxes, cls = '', mark = '') => (boxes.length
  ? `<div class="qgrp ${cls}"><p class="grp">${mark}${esc(label)}</p><div class="qnodes">${boxes.join('')}</div></div>` : '');
// Team marker for labels: a filled square for Home, an outlined one for Away.
const mk = team => `<i class="mk ${team}" aria-hidden="true"></i>`;

function renderTonight() {
  const here = new Set(state.players.map(p => p.name.toLowerCase()));
  const waiting = state.expected.filter(n => !here.has(n.toLowerCase()));
  $('expectedCount').textContent = state.expected.length ? `${waiting.length} OF ${state.expected.length} TO ARRIVE` : '';
  $('expected').innerHTML = waiting.map(n => {
    const p = profileOf(n), name = p?.name ?? n;
    const record = !profiles.size ? '' : p?.games ? `${plural(p.games, 'game')} · ${p.points} points · AVG ${p.avg.toFixed(1)}` : 'First game';
    return `<tr>
      <td><b>${esc(name)}</b><small>${record}</small></td>
      <td class="act"><span>${btn('checkIn', name, 'Check in', { cls: 's' })}<button type="button" class="xbtn" data-action="removeName"
        data-name="${esc(n)}" data-arg="" aria-label="Remove ${esc(name)} from tonight's list">&times;</button></span></td>
    </tr>`;
  }).join('') || `<tr><td colspan="2" class="empty">${state.expected.length
    ? 'Everyone on the list has checked in.' : 'Nobody on the list yet. Add players above, or paste this week\'s list.'}</td></tr>`;

  // Everyone checked in tonight as small boxes (the queue diagram's), grouped by where they
  // are now, newest first in each group. #n is their arrival order.
  const newest = state.players.map((p, i) => ({ p, n: i + 1 })).reverse();
  $('here').innerHTML = [
    ['Waiting', x => x.p.present && !seatOf(x.p.name), ''],
    ['On court', x => x.p.present && seatOf(x.p.name), ' on'],
    ['Done for the night', x => !x.p.present, ' out'],
  ].map(([label, test, cls]) => {
    const list = newest.filter(test);
    return boxGroup(`${label} · ${list.length}`, list.map(({ p, n }) =>
      `<div class="qn${cls}" title="${esc(p.name)} · ${plural(p.games, 'game')} tonight"><b>${esc(p.name)}</b><small>#${n}</small></div>`));
  }).join('') || '<p class="empty">Nobody checked in yet.</p>';

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
