// Basketball session: state, saving, rendering, scoreboard and clock.
// The fairness rules live in queue.js.

const GAME_MINUTES = 20;
const TEAM_SIZE = 5; // volleyball will be 6
const SPOTS = TEAM_SIZE * 2;
const GAME_MS = GAME_MINUTES * 60000;
const KEY = 'pickup-rotation-v1';

const $ = id => document.getElementById(id);
const newGame = number => ({
  number, onCourt: [], satOut: [], homeName: 'Home', awayName: 'Away',
  remainingMs: GAME_MS, endsAt: null, started: false,
});
const newSession = () => ({ players: [], game: newGame(1), log: [], expected: [], unsynced: [], startedAt: Date.now() });

let state = load();
let saved = true;
let audio; // created on the first click; browsers block sound before one
let profiles = new Map(); // lowercase name -> { name, games, points, avg } from players.db
let db = 'connecting'; // 'online' | 'offline'

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s) {
      delete s.roster; // replaced by the database
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
const score = team => state.game.onCourt.filter(c => c.team === team).reduce((t, c) => t + c.points, 0);
const remaining = () => (state.game.endsAt ? Math.max(0, state.game.endsAt - Date.now()) : state.game.remainingMs);
const clockText = ms => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const ready = () => {
  const court = state.game.onCourt;
  return court.length > 0 && court.every(c => c.team) && ['home', 'away'].every(t => court.some(c => c.team === t));
};
const cleanName = Names.clean;
const profileOf = name => profiles.get(name.toLowerCase());
const playerNamed = name => state.players.find(p => p.name.toLowerCase() === name.toLowerCase());
const avgText = name => {
  if (db !== 'online') return '';
  const p = profileOf(name);
  return p?.games ? `AVG ${p.avg.toFixed(1)}` : 'NEW';
};
const localDate = ms => new Date(ms).toLocaleDateString('en-CA'); // YYYY-MM-DD
const btn = (action, name, label, { arg = '', pressed, cls = 'o s' } = {}) =>
  `<button class="btn ${cls}" data-action="${action}" data-name="${esc(name)}" data-arg="${arg}"` +
  `${pressed === undefined ? '' : ` aria-pressed="${pressed}"`}>${label}</button>`;

// ---- tabs: the island. A tab hides every panel but its own and scrolls to the top ----

const TABS = ['queue', 'board'];
const island = $('island'), thumb = island.querySelector('.island-thumb');
const tabs = [...island.querySelectorAll('[role="tab"]')];
let active = 'queue';

function place() {
  const b = island.querySelector('[aria-selected="true"]');
  if (!b) return;
  thumb.style.width = b.offsetWidth + 'px';
  thumb.style.transform = `translateX(${b.offsetLeft}px)`;
}
function show(name) {
  if (!TABS.includes(name)) name = 'queue';
  const changed = name !== active;
  active = name;
  tabs.forEach(t => { const on = t.dataset.tab === name; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; });
  TABS.forEach(id => { $(id).hidden = id !== name; });
  place();
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

// ---- database: players.db through server.py; the app keeps working without it ----

class Rejected extends Error {}

async function api(path, body) {
  if (location.protocol === 'file:') throw new Error('opened as a file');
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (res.status === 400) throw new Rejected((await res.json()).error);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  profiles = new Map((await res.json()).map(p => [p.name.toLowerCase(), p]));
  db = 'online';
}

// Finished games wait in state.unsynced (saved in this browser) until the database has them.
async function sync() {
  try {
    await api('/api/profiles');
    while (state.unsynced.length) {
      try { await api('/api/results', state.unsynced[0]); }
      catch (e) { if (!(e instanceof Rejected)) throw e; flash(`The database rejected a game: ${e.message}`); }
      state.unsynced.shift();
      save();
    }
  } catch (e) {
    if (!(e instanceof Rejected)) db = 'offline';
  }
  render();
}

function checkIn(raw) {
  const typed = cleanName(raw);
  if (!typed) return;
  const p = playerNamed(typed);
  if (p?.present) return flash(`${p.name} is already checked in.`);
  if (p) { p.present = true; flash(`${p.name} is back, same place in line.`); }
  else {
    const name = profileOf(typed)?.name ?? typed; // keep the database's spelling
    state.players.push({ name, games: 0, readyAt: Date.now(), present: true, totalPoints: 0 });
    flash(`${name} checked in.`);
  }
  commit();
}

// ---- name autosuggest (check-in and tonight's list) ----

let editingList = !state.expected.length; // page only, not saved
let needsChoice = []; // pasted names that match several players: { query, choices }

const onList = name => state.expected.some(n => n.toLowerCase() === name.toLowerCase());
function addToList(name) { if (name && !onList(name)) state.expected.push(name); }

// Everyone the app knows: the database, tonight's list and tonight's players.
function knownPeople() {
  const people = new Map([...profiles.values()].map(p => [p.name.toLowerCase(), { ...p }]));
  for (const name of [...state.expected, ...state.players.map(p => p.name)]) {
    const key = name.toLowerCase();
    people.set(key, { ...(people.get(key) ?? { name, games: 0 }), priority: onList(name), here: !!playerNamed(name)?.present });
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
      label: [p.here && 'CHECKED IN', p.priority && 'TONIGHT', avgText(p.name)].filter(Boolean).join(' · '),
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
  fill: () => Queue.fill(state.players, state.game, SPOTS),
  pick: name => Queue.pick(state.game, name, SPOTS),
  sitOut: name => Queue.sitOut(state.game, name),
  team: (name, team) => { const c = seatOf(name); c.team = c.team === team ? null : team; },
  out: name => { player(name).present = false; },
  back: name => { player(name).present = true; },
  checkIn: name => { checkIn(name); return false; },
  removeName: name => { state.expected = state.expected.filter(n => n !== name); },
  choose: (name, query) => { needsChoice = needsChoice.filter(c => c.query !== query); addToList(name); },
  editList: () => { editingList = true; setTimeout(() => $('listAdd').focus()); },
  doneList() {
    editingList = false;
    if (state.expected.length) api('/api/players', { names: state.expected }).catch(() => {}).then(render);
  },
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
    state.log.push(...Queue.endGame(state.players, g, Date.now()));
    state.unsynced.push({
      session: state.startedAt, date: localDate(state.startedAt), game: g.number,
      rows: g.onCourt.map(c => ({ name: c.name, points: c.points })),
    });
    state.game = newGame(g.number + 1);
    setTimeout(sync);
    if (document.fullscreenElement) document.exitFullscreen();
    go('queue');
  },

  newSession() {
    if (!confirm('Start a new session? This clears tonight\'s players, list and points. The database keeps every result.')) return false;
    state = { ...newSession(), unsynced: state.unsynced };
  },

  fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else $('board').requestFullscreen?.();
    return false;
  },
};

document.addEventListener('click', e => {
  try { audio ??= new AudioContext(); } catch {}
  const b = e.target.closest('[data-action]');
  if (b && actions[b.dataset.action](b.dataset.name, b.dataset.arg) !== false) commit();
});

const checkInBox = autosuggest($('name'), $('nameSug'), checkIn, flash);
$('checkin').onsubmit = e => { e.preventDefault(); checkInBox.enter(); };

const listSay = text => { $('listMsg').textContent = text; };
autosuggest($('listAdd'), $('listSug'), name => {
  if (onList(name)) return listSay(`${name} is already on the list.`);
  addToList(name);
  commit();
}, listSay);

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

function render() {
  renderQueue();
  renderBoard();
  renderClock();
  renderTonight();
}

function renderQueue() {
  const g = state.game;
  const locked = g.started;
  const open = !locked && g.onCourt.length < SPOTS;
  const order = Queue.waitingOrder(state.players, g);
  const next = new Set(Queue.nextInLine(state.players, g, SPOTS).map(p => p.name));
  const passed = new Set(locked ? [] : Queue.passedOver(state.players, g)); // nothing to fix once play starts
  const present = state.players.filter(p => p.present).length;
  const now = Date.now();
  const time = new Date(state.startedAt ?? now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  $('sessionLine').textContent = `Session started ${time} · ${present} checked in · ${order.length} waiting`;
  $('fillBtn').hidden = locked;
  $('fillBtn').disabled = !open || !next.size;
  $('upnextIntro').textContent = locked
    ? `Game ${g.number} is on. Spots unlock when it ends.`
    : `Game ${g.number}. ${g.onCourt.length} of ${SPOTS} spots filled. Players choose sides, then set each one's team here.`;

  $('upnext').innerHTML = g.onCourt.map((c, i) => `<tr>
      <td class="n">${i + 1}</td>
      <td><b>${esc(c.name)}</b><small>${plural(player(c.name).games, 'game')} tonight${tag(c.name)}</small></td>
      <td class="act"><span>
        <span class="seg">${['home', 'away'].map(t => btn('team', c.name, esc(g[t + 'Name']), { arg: t, pressed: c.team === t, cls: c.team === t ? 's' : 'o s' })).join('')}</span>
        ${locked ? '' : btn('sitOut', c.name, 'Sit out')}
      </span></td>
    </tr>`).join('') || '<tr><td colspan="3" class="empty">Nobody called yet. Press Fill open spots.</td></tr>';

  $('waiting').innerHTML = order.map((p, i) => {
    const tags = (next.has(p.name) ? '<span class="stt live">Next in line</span>' : '')
      + (g.satOut.includes(p.name) ? '<span class="stt plan">Sitting out</span>' : '')
      + (passed.has(p.name) ? '<span class="stt build">Passed over</span>' : '');
    return `<tr>
      <td class="n">${i + 1}</td>
      <td><b>${esc(p.name)}</b><small>${plural(p.games, 'game')} tonight · waiting ${Math.floor((now - p.readyAt) / 60000)} min${tag(p.name)}</small></td>
      <td class="tags hide-sm"><span>${tags}</span></td>
      <td class="act"><span>${open ? btn('pick', p.name, 'Pick') : ''}${btn('out', p.name, 'Out')}</span></td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="empty">Nobody waiting.</td></tr>';

  const out = state.players.filter(p => !p.present);
  $('outBox').hidden = !out.length;
  $('out').innerHTML = out.map(p => `<tr>
      <td><b>${esc(p.name)}</b><small>${plural(p.games, 'game')}</small></td>
      <td class="act">${btn('back', p.name, 'Back')}</td>
    </tr>`).join('');

  $('leaders').innerHTML = [...state.players]
    .sort((a, b) => b.totalPoints - a.totalPoints || a.name.localeCompare(b.name))
    .map(p => `<tr><td><b>${esc(p.name)}</b></td><td class="r mono">${p.games}</td><td class="r mono">${p.totalPoints}</td><td class="r mono">${avgText(p.name)}</td></tr>`)
    .join('') || '<tr><td colspan="4" class="empty">No players yet.</td></tr>';

  const pending = state.unsynced.length;
  $('saveLine').textContent = [
    saved ? 'Saved in this browser' : 'Not saved',
    { online: 'Database online', offline: 'Database offline', connecting: 'Connecting to database' }[db],
    pending && `${plural(pending, 'game')} not in the database yet`,
  ].filter(Boolean).join(' · ');
}

const tag = name => (avgText(name) ? ` · ${avgText(name)}` : '');

function renderTonight() {
  const here = new Set(state.players.map(p => p.name.toLowerCase()));
  const waiting = state.expected.filter(n => !here.has(n.toLowerCase()));
  const offline = db === 'offline';
  $('expectedIntro').textContent = offline
    ? 'Database offline. Start server.py to load profiles. Check-in still works.'
    : 'This week\'s list with each player\'s record. Check people in as they arrive.';
  $('expected').innerHTML = waiting.map(n => {
    const p = profileOf(n), name = p?.name ?? n;
    const record = offline ? '' : p?.games ? `${plural(p.games, 'game')} · ${p.points} points · AVG ${p.avg.toFixed(1)}` : 'First game';
    return `<tr>
      <td><b>${esc(name)}</b><small>${record}</small></td>
      <td class="act">${btn('checkIn', name, 'Check in', { cls: 's' })}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="2" class="empty">${state.expected.length
    ? 'Everyone on the list has checked in.' : 'No list yet. Add this week\'s players above.'}</td></tr>`;

  $('listEditor').hidden = !editingList;
  $('listFolded').hidden = editingList;
  $('listCount').textContent = state.expected.length
    ? `${plural(state.expected.length, 'player')} on tonight's list.` : 'No list tonight.';
  $('tonightCount').textContent = plural(state.expected.length, 'name').toUpperCase();
  $('chips').innerHTML = state.expected.map(n => `<li class="chip">${esc(n)}${
    db === 'online' && !profileOf(n)?.games ? '<span class="mono">NEW</span>' : ''}<button type="button" data-action="removeName"
      data-name="${esc(n)}" aria-label="Remove ${esc(n)}">&times;</button></li>`).join('');
  $('choices').innerHTML = needsChoice.map(c => `<div class="notice">
      <b>${esc(c.query)} matches ${c.choices.length} players. Which one is coming?</b>
      <div class="btns">${[...c.choices.map(n => btn('choose', n, esc(n), { arg: esc(c.query) })),
        btn('choose', c.query, 'New player', { arg: esc(c.query) })].join('')}</div>
    </div>`).join('');
  $('doneBtn').disabled = needsChoice.length > 0;

  const pending = state.unsynced.length;
  $('dbChip').className = `stt ${pending ? 'build' : offline ? 'plan' : 'live'}`;
  $('dbChip').textContent = pending ? `${pending} unsaved` : offline ? 'Offline' : db === 'online' ? 'Online' : 'Connecting';
  $('dbLine').textContent = offline
    ? 'Run python3 server.py in this folder, then open http://localhost:8000.'
    : `${plural(profiles.size, 'player')} on file · ${plural([...profiles.values()].reduce((t, p) => t + p.games, 0), 'result')}.`;
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
setInterval(renderQueue, 15000); // keep wait times current

route();
render();
sync();
