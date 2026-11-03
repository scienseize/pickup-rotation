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
const newSession = roster => ({ players: [], game: newGame(1), log: [], roster, startedAt: Date.now() });

let state = load();
let saved = true;
let audio; // created on the first click; browsers block sound before one

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s) return s;
  } catch {}
  return newSession([]);
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

// ---- actions (each click handler; return false to skip saving) ----

const actions = {
  fill: () => Queue.fill(state.players, state.game, SPOTS),
  pick: name => Queue.pick(state.game, name, SPOTS),
  sitOut: name => Queue.sitOut(state.game, name),
  team: (name, team) => { const c = seatOf(name); c.team = c.team === team ? null : team; },
  out: name => { player(name).present = false; },
  back: name => { player(name).present = true; },
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
    state.game = newGame(g.number + 1);
    if (document.fullscreenElement) document.exitFullscreen();
    go('queue');
  },

  newSession() {
    if (!confirm('Start a new session? This clears all players, games and points. The member list is kept.')) return false;
    state = newSession(state.roster);
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

$('checkin').onsubmit = e => {
  e.preventDefault();
  const name = $('name').value.trim().replace(/\s+/g, ' ');
  if (!name) return;
  const p = state.players.find(p => p.name.toLowerCase() === name.toLowerCase());
  if (p?.present) return flash(`${p.name} is already checked in.`);
  if (p) { p.present = true; flash(`${p.name} is back, same place in line.`); }
  else { state.players.push({ name, games: 0, readyAt: Date.now(), present: true, totalPoints: 0 }); flash(`${name} checked in.`); }
  $('name').value = '';
  commit();
};

$('roster').oninput = e => {
  state.roster = e.target.value.split('\n').map(s => s.trim()).filter(Boolean);
  save();
  renderMembers();
};

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
  renderMembers();
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
      <td><b>${esc(c.name)}</b><small>${plural(player(c.name).games, 'game')}</small></td>
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
      <td><b>${esc(p.name)}</b><small>${plural(p.games, 'game')} · waiting ${Math.floor((now - p.readyAt) / 60000)} min</small></td>
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
    .map(p => `<tr><td><b>${esc(p.name)}</b></td><td class="r mono">${p.games}</td><td class="r mono">${p.totalPoints}</td></tr>`)
    .join('') || '<tr><td colspan="3" class="empty">No players yet.</td></tr>';

  $('saveLine').textContent = saved ? 'Saved in this browser' : 'Not saved';
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
        <b>${esc(c.name)}</b><span class="pts">${c.points}</span>
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

function renderMembers() {
  if (document.activeElement !== $('roster')) $('roster').value = state.roster.join('\n');
  $('members').innerHTML = state.roster.map(n => `<option value="${esc(n)}">`).join('');
  $('memberCount').textContent = plural(state.roster.length, 'name');
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
