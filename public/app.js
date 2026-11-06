// Basketball session: state, saving, rendering, scoreboard and clock.
// The fairness rules live in queue.js.

const GAME_MINUTES = 20;
const TEAM_SIZE = 5; // volleyball will be 6
const SPOTS = TEAM_SIZE * 2;
const GAME_MS = GAME_MINUTES * 60000;
const KEY = 'pickup-rotation-v1';
const MIN_RANKED_GAMES = 2; // per-game ranking: one lucky game shouldn't top the board
const MIN_FG_SHOTS = 5; // fewer attempts than this and FG% is greyed out: 1 of 1 isn't 100% shooting
const MIN_ALLTIME_GAMES = 3; // the all-time leaderboard ranks players with at least this many games

const $ = id => document.getElementById(id);
const newGame = number => ({
  number, onCourt: [], subbedOut: [], satOut: [], homeName: 'Home', awayName: 'Away',
  remainingMs: GAME_MS, endsAt: null, started: false,
});
const newSession = () => ({ players: [], game: newGame(1), expected: [], unsynced: [], kinds: [], startedAt: Date.now() });

let state = load();
let saved = true;
let audio; // created on the first click; browsers block sound before one
const PASS_KEY = 'pickup-passcode', PROFILES_KEY = 'pickup-profiles';
const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
// lowercase name -> { name, games, points, avg }; the last copy is kept so profiles still show offline
let profiles = new Map((JSON.parse(stored(PROFILES_KEY)) || []).map(p => [p.name.toLowerCase(), p]));
let leaderMode = 'tonight'; // 'tonight' | 'alltime', the leaderboard toggle
let leaderKind = 'all'; // 'all' or a player type, the leaderboard filter
let kindPick = null; // the player whose type picker is open
let db = 'connecting'; // 'online' | 'offline' | 'locked' (needs the organizer passcode)

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s) {
      delete s.roster; // replaced by the database
      delete s.log; // never read
      const st = { expected: [], unsynced: [], kinds: [], startedAt: Date.now(), ...s };
      seatTeams(st.game); // saved before every called player had a team
      // Saved before shots were tracked: start everyone's shots at 0.
      for (const c of [...st.game.onCourt, ...(st.game.subbedOut ?? [])]) Object.assign(c, { fgm: c.fgm ?? 0, fga: c.fga ?? 0, log: c.log ?? [] });
      for (const p of st.players) Object.assign(p, { fgm: p.fgm ?? 0, fga: p.fga ?? 0, wins: p.wins ?? 0, losses: p.losses ?? 0 });
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
// Player types live on the person in the database. A change waits in state.kinds until the
// database has it, so it also works offline. Tags use the short label; hover gives the full one.
const KINDS = ['UG', 'SHS', 'Alumni', 'Outsider'];
const KIND_SHORT = { UG: 'UG', SHS: 'SHS', Alumni: 'Alum', Outsider: 'Vis' };
// Shown as Visitor; the database keeps the value Outsider, since its rule allows only the original four.
const kindLabel = k => (k === 'Outsider' ? 'Visitor' : k);
const kindOf = name => { const k = state.kinds.find(x => x.name === name); return k ? k.kind : profileOf(name)?.kind ?? null; };
const kindShort = name => KIND_SHORT[kindOf(name)] ?? '';
const kindClass = name => (kindOf(name) ? `k-${kindOf(name).toLowerCase()}` : 'unset');
const kindTag = name => (kindOf(name) ? `<span class="kt ${kindClass(name)}" title="${kindLabel(kindOf(name))}">${kindShort(name)}</span>` : '');
// A tag that opens the picker; a player with no type shows a faint "Type".
const kindBtn = name => `<button type="button" class="kt ${kindClass(name)}" data-action="pickKind" data-name="${esc(name)}" data-arg=""
  title="${kindLabel(kindOf(name)) ?? 'Set type'}" aria-label="${kindOf(name) ? `${esc(name)} is ${kindLabel(kindOf(name))}. Change type` : `Set type for ${esc(name)}`}">${kindShort(name) || 'Type'}</button>`;
const kindPicker = name => `<div class="kpick" role="group" aria-label="Type for ${esc(name)}">${KINDS.map(k =>
  btn('setKind', name, kindLabel(k), { arg: k, pressed: kindOf(name) === k, cls: kindOf(name) === k ? 's' : 'o s' })).join('')}${
  kindOf(name) ? `<button type="button" class="xbtn" data-action="setKind" data-name="${esc(name)}" data-arg="" aria-label="Clear type">&times;</button>` : ''}</div>`;
function closeKindPick() { kindPick = null; renderTonight(); renderLeaders(); }
const playerNamed = name => state.players.find(p => p.name.toLowerCase() === name.toLowerCase());
const pct = (made, tried) => `${Math.round((made / tried) * 100)}%`;
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
  if (name === 'leaders') renderLeaders();
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
    while (state.kinds.length) {
      const k = state.kinds[0];
      try { await api('/api/kind', k); }
      catch (e) { if (!(e instanceof Rejected)) throw e; flash(`The database rejected a player type: ${e.message}`); }
      state.kinds = state.kinds.filter(x => x !== k); // a newer tap for this player may have replaced it
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
  state.players.push({ name, games: 0, readyAt: Date.now(), present: true, totalPoints: 0, fgm: 0, fga: 0, wins: 0, losses: 0 });
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
  leaderMode(_, mode) { leaderMode = mode; keepFocus(renderLeaders); return false; }, // a view choice, not saved
  leaderKind(_, kind) { leaderKind = kind; keepFocus(renderLeaders); return false; }, // so is the filter
  checkIn: name => { checkIn(name); return false; },
  removeName: name => { state.expected = state.expected.filter(n => n !== name); },
  choose: (name, query) => { needsChoice = needsChoice.filter(c => c.query !== query); addToList(name); saveList(); },
  pasteList() {
    $('pasteDlg').returnValue = '';
    $('pasteDlg').showModal();
    return false;
  },
  // Scoring is in field goals: Miss is an attempt; +2 and +3 are points and a make (an attempt
  // too). Undo reverses the player's last tap, so points and shots always agree.
  miss(name) { const c = seatOf(name); c.fga += 1; c.log.push(0); },
  make(name, n) {
    const c = seatOf(name), pts = Number(n);
    if (pts !== 2 && pts !== 3) return false;
    Object.assign(c, { points: c.points + pts, fgm: c.fgm + 1, fga: c.fga + 1 });
    c.log.push(pts);
  },
  undo(name) {
    const c = seatOf(name), last = c.log.pop();
    if (last === undefined) return false;
    c.fga -= 1;
    if (last) { c.fgm -= 1; c.points -= last; }
  },

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
      rows: Queue.played(g).map(c => ({ name: c.name, points: c.points, fgm: c.fgm, fga: c.fga, won: Queue.won(g, c) })),
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
    state = { ...newSession(), unsynced: state.unsynced, kinds: state.kinds };
    needsChoice = [];
  },

  // From the queue diagram: a waiting player in for someone on court. No confirm: swapping back undoes it.
  sub: (outName, inName) => { Queue.sub(state.game, outName, inName, locked()); },

  flip() { state.flipped = !state.flipped; }, // Switch sides: which team shows on the left

  // Player type: a tag opens the picker under that row; picking saves it, and sync sends it.
  pickKind(name) { kindPick = kindPick === name ? null : name; keepFocus(() => { renderTonight(); renderLeaders(); }); return false; },
  setKind(name, kind) {
    state.kinds = [...state.kinds.filter(k => k.name !== name), { name, kind: kind || null }];
    kindPick = null;
    setTimeout(sync);
  },

  fullscreen(_, arg) {
    if (document.fullscreenElement) document.exitFullscreen();
    else $(arg || 'board').requestFullscreen?.();
    return false;
  },
};

document.addEventListener('click', e => {
  try { audio ??= new AudioContext(); } catch {}
  if (kindPick && !e.target.closest('.kpick,[data-action="pickKind"]')) closeKindPick(); // a click elsewhere
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

document.addEventListener('keydown', e => { if (e.key === 'Escape' && kindPick) closeKindPick(); });
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

  renderLeaders();

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
// waiting, Pick and Done; done, Undo. Clicking a second box pairs them: someone waiting or in the
// lineup and someone on court (a sub), a waiting player and someone in the lineup (a replacement), or two
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
    if (src === 'next') return (seat ? '' : btn('done', name, 'Done')) + '<small class="hint">click someone on court to sub in, or a waiting player to swap</small>';
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
      tabindex="0" role="button" aria-pressed="${picked}" title="${esc(name)}"><b>${esc(shortName(name))}</b><span class="qsub">${kindTag(name)}<small>${notes.join(' · ')}</small></span>${
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
// A sub can come from the waiting side or from the lineup.
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
  if (aSrc !== bSrc && [aSrc, bSrc].every(s => s === 'court' || s === 'next')) { // someone in the lineup and someone on court: sub in now
    const [inn, out] = aSrc === 'next' ? [a, b] : [b, a];
    return seatOf(inn) ? false : run(() => actions.sub(out, inn));
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
  if (src === 'next') return; // onto a team's area: a lineup player subs in by landing on someone
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

// Leaderboard: Tonight (this session, ranked by points) or All-time (every week in the database,
// ranked by points per game, MIN_ALLTIME_GAMES games minimum). The ranked figure is the big one,
// ranks 1 to 3 are a podium (ties share it), and the list splits into tables side by side so it
// fits the screen (leaderTables).
function renderLeaders() {
  const all = leaderMode === 'alltime';
  $('leaderIntro').textContent = all
    ? `Every week, ranked by points per game (${MIN_ALLTIME_GAMES}+ games).`
    : 'Tonight, ranked by points.';
  $('leaderMode').innerHTML = [['tonight', 'Tonight'], ['alltime', 'All-time']]
    .map(([m, label]) => btn('leaderMode', '', label, { arg: m, pressed: leaderMode === m, cls: leaderMode === m ? 's' : 'o s' })).join('');
  $('leaderKinds').innerHTML = [['all', 'All'], ...KINDS.map(k => [k, kindLabel(k)])]
    .map(([k, label]) => btn('leaderKind', '', label, { arg: k, pressed: leaderKind === k, cls: leaderKind === k ? 's' : 'o s' })).join('');
  // All-time players come from the database profiles, in the shape Queue.leaderboard takes. The
  // type filter comes first, so ranks start at 1 within the type.
  const list = (!all ? state.players : [...profiles.values()].filter(p => p.games).map(p => ({
    name: p.name, games: p.games, totalPoints: p.points, fgm: p.fgm ?? 0, fga: p.fga ?? 0, wins: p.wins ?? 0, losses: p.losses ?? 0 })))
    .filter(p => leaderKind === 'all' || kindOf(p.name) === leaderKind);
  const rows = Queue.leaderboard(list, all ? 'perGame' : 'total', all ? MIN_ALLTIME_GAMES : MIN_RANKED_GAMES);
  const played = rows.filter(r => r.player.games), notYet = all ? [] : rows.filter(r => !r.player.games);
  const when = all ? 'every week' : 'tonight';
  // FG%: makes over attempts, e.g. "6/10 60%"; blank with no attempts, greyed out under MIN_FG_SHOTS.
  const fgCell = (p, fgPct) => (fgPct === null ? '<td class="r mono fg"></td>'
    : `<td class="r mono fg${p.fga < MIN_FG_SHOTS ? ' few' : ''}" title="${p.fgm} of ${p.fga} ${when}${
      p.fga < MIN_FG_SHOTS ? `, under ${MIN_FG_SHOTS} attempts` : ''}"><small>${p.fgm}/${p.fga}</small> ${fgPct}%</td>`);
  // Record, e.g. "3-1" (ties count for neither), and the share of decided games won.
  const decided = p => (p.wins ?? 0) + (p.losses ?? 0);
  const wl = p => (decided(p) ? `${p.wins ?? 0}-${p.losses ?? 0}` : '');
  const cell = (v, cls = 'r mono') => `<td class="${cls}">${v}</td>`;
  const big = v => cell(v, 'r pts');
  const row = ({ player: p, perGame: pg, fgPct, rank }) => `<tr class="${!rank ? 'un' : rank <= 3 ? `top p${rank}` : ''}">
      <td class="n">${rank ?? ''}</td><td class="who"><div><b title="${esc(p.name)}">${esc(p.name)}</b>${all ? kindBtn(p.name) : kindTag(p.name)}</div></td>${cell(p.games, 'r mono gm')}${all
      ? big(pg.toFixed(1)) + cell(p.totalPoints, 'r mono sub') + fgCell(p, fgPct) + cell(wl(p), 'r mono sub') + cell(decided(p) ? pct(p.wins, decided(p)) : '')
      : big(p.totalPoints) + cell(pg === null ? '' : pg.toFixed(1), 'r mono sub') + fgCell(p, fgPct) + cell(wl(p))}</tr>${
      all && kindPick === p.name ? `<tr class="pickrow"><td colspan="8">${kindPicker(p.name)}</td></tr>` : ''}`;
  const th = (label, title, cls = 'r') => `<th class="${cls}" title="${title}">${label}</th>`;
  const head = `<tr><th>#</th><th>Player</th>${th('Games', `Games ${when}`, 'r gm')}${all
    ? th('PPG', 'Points per game, every week') + th('Points', 'Total points, every week', 'r sub') + th('FG%', 'Field goals made / attempted, every week')
      + th('W-L', 'Wins and losses, every week', 'r sub') + th('Win%', 'Share of decided games won, every week')
    : th('Points', 'Points tonight') + th('Per game', 'Points per game tonight', 'r sub') + th('FG%', 'Field goals made / attempted tonight')
      + th('W-L', 'Wins and losses tonight')}</tr>`;
  const table = part => `<div class="tw"><table><thead>${head}</thead><tbody>${part.map(row).join('')}</tbody></table></div>`;
  const k = leaderTables(played.length), per = Math.ceil(played.length / k), parts = [];
  for (let i = 0; i < played.length; i += per) parts.push(played.slice(i, i + per));
  const lb = $('leaderBoard');
  lb.className = `wide lb${k > 1 ? ' split' : ''}${k > 2 ? ' split3' : ''}`;
  lb.style.setProperty('--k', k);
  lb.innerHTML = all && !profiles.size ? '<p class="empty">All-time stats need the database. Check the dot in the top bar.</p>'
    : !rows.length ? `<p class="empty">${leaderKind !== 'all' ? `No ${kindLabel(leaderKind)} players here yet.` : all ? 'No games in the database yet.' : 'No players yet.'}</p>`
    : (!played.length ? '<p class="empty">No games played yet.</p>' : parts.map(table).join(''))
      + (notYet.length ? `<p class="rest">Not played yet: ${notYet.map(r => esc(r.player.name)).join(', ')}</p>` : '');
  fitLeaders();
}
// How many tables side by side: one up to 12 players; past that, as many as it takes for the rows
// to fit between the top of the list and the bottom of the screen, up to 3 where the page is wide
// enough (2 otherwise). Below 1100px wide the tables stack, so the page scrolls.
function leaderTables(n) {
  if (n <= 12) return 1;
  const lb = $('leaderBoard');
  if ($('leaders').hidden || innerWidth < 1100) return 2; // laid out again when the tab shows
  const room = innerHeight - (lb.getBoundingClientRect().top + scrollY) - 24 - 34 - 40; // header row, the "not played" line
  const rows = Math.max(8, Math.floor((room - 42) / 28)); // about 28px a row; the podium's 3 rows take about 42px more
  return Math.min(lb.parentElement.clientWidth >= 1200 ? 3 : 2, Math.max(2, Math.ceil(n / rows)));
}
window.addEventListener('resize', () => { if (!$('leaders').hidden) renderLeaders(); });

// Leaderboard in full screen: scale the title and table (CSS zoom) so they fill the TV, as large as
// both the width and the height allow, or smaller when a big night would not fit. Out of full
// screen it is the normal page.
function fitLeaders() {
  const t = $('leaders'), parts = [...t.children]; // the title block and the table: the panel stays screen-sized
  const zoom = z => parts.forEach(c => { c.style.zoom = z; });
  if (document.fullscreenElement !== t) return zoom('');
  zoom(1);
  // The content's own size: the table's width, and from the title's top to the table's bottom.
  const w = $('leaderBoard').offsetWidth, h = $('leaderBoard').getBoundingClientRect().bottom - parts[0].getBoundingClientRect().top;
  zoom(Math.max(0.5, Math.min(3, Math.min(innerWidth / w, innerHeight / h) * 0.9)).toFixed(3)); // shrinks for a big night
}
document.addEventListener('fullscreenchange', fitLeaders);
window.addEventListener('resize', fitLeaders);

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
    const cols = stacks.reduce((c, st) => c + Math.max(...st.map(i => Math.ceil(ns[i] / rows))), 0);
    return { rows, stacks, cols, width: cols * COL_W + GROUP_GAP * (stacks.length - 1) };
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
    const record = !profiles.size ? '' : pr?.games
      ? ` · ${plural(pr.games, 'game')} · AVG ${pr.avg.toFixed(1)}${pr.fga ? ` · FG ${pct(pr.fgm, pr.fga)}` : ''}${
        pr.wins || pr.losses ? ` · ${pr.wins}-${pr.losses}` : ''}` : ' · First game';
    const type = kindOf(name) ? ` · ${kindLabel(kindOf(name))}` : '';
    const games = p ? `<small>${p.games}g</small>` : ''; // short, so the name and type have room
    const trail = key === 'arrive'
      ? btn('checkIn', name, 'Check in', { cls: 's' }) + `<button type="button" class="xbtn" data-action="removeName"
        data-name="${esc(n)}" data-arg="" aria-label="Remove ${esc(name)} from tonight's list">&times;</button>`
      : key === 'here' ? games + btn('done', name, 'Done') : key === 'done' ? games + btn('undoDone', name, 'Undo') : games;
    return `<div class="rrow" title="${esc(name)}${type}${p ? ` · ${plural(p.games, 'game')} tonight` : ''}${record}">${kindBtn(name)}<b>${esc(name)}</b>${trail}</div>${
      kindPick === name ? kindPicker(name) : ''}`;
  };
  const heads = { home: [mk('home'), g.homeName], away: [mk('away'), g.awayName], here: ['<i class="sdot" aria-hidden="true"></i>', 'Here'],
    arrive: ['', 'To arrive'], done: ['', 'Done for the night'] };
  const keys = Object.keys(groups).filter(k => groups[k].length);
  const { rows, stacks, cols: colCount } = rosterLayout(keys.map(k => groups[k].length));
  // Columns share any spare width, up to 260px, so names stay readable with their type tag.
  const spare = colCount ? ($('roster').clientWidth - GROUP_GAP * (stacks.length - 1)) / colCount - 8 : 0;
  $('roster').style.setProperty('--colw', `${Math.max(212, Math.min(260, Math.floor(spare)))}px`);
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
        <span><b>${esc(c.name)}</b>${kindTag(c.name)}<small class="mono">${[avgText(c.name), `FG ${c.fgm}/${c.fga}`].filter(Boolean).join(' · ')}</small></span><span class="pts">${c.points}</span>
        <span class="pt">${btn('miss', c.name, 'Miss', { cls: 'o' })}${btn('make', c.name, '+2', { arg: 2, cls: 'o' })}${
          btn('make', c.name, '+3', { arg: 3, cls: 'o' })}${btn('undo', c.name, 'Undo', { cls: 'o', disabled: !c.log.length })}</span>
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
