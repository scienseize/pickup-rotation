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
const SESSION_DAY = 4; // sessions are on Thursdays (Sunday is 0)
const localDate = ms => new Date(ms).toLocaleDateString('en-CA'); // YYYY-MM-DD
// The session day on or after the day of ms, in local time, as YYYY-MM-DD.
function sessionDate(ms) {
  const d = new Date(ms);
  d.setDate(d.getDate() + (SESSION_DAY - d.getDay() + 7) % 7);
  return localDate(d.getTime());
}
// "Thursday, November 12" from YYYY-MM-DD, read as a local date (not UTC).
function dateLabel(date) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}
const newGame = number => ({
  number, onCourt: [], subbedOut: [], satOut: [], homeName: 'Home', awayName: 'Away',
  remainingMs: GAME_MS, endsAt: null, started: false,
});
const newSession = (now = Date.now()) => ({ players: [], game: newGame(1), expected: [], unsynced: [], kinds: [], seen: {}, startedAt: now, date: sessionDate(now) });

// The guest view: the home page (/) for anyone not signed in. Leaderboard and History only, read-only,
// refreshed every 30 seconds from the public API. The server enforces it; this only hides what can't work.
const GUEST = location.pathname === '/' || location.pathname === '/index.html';
const GUEST_MS = 30000; // slow on purpose: many phones at 2 s would use up the free plan's daily requests
const VIEW_OPS = new Set(['leaderMode', 'leaderKind', 'goTab', 'theme', 'askGuest']); // the only actions a guest can run
let guestLocked = false; // a guest without this week's code (none yet, or the week moved on)

let fresh = true; // nothing was saved here: this laptop must join the server's session, never replace it
let state = load();
let saved = true;
let audio; // created on the first click; browsers block sound before one
const PASS_KEY = 'pickup-passcode', PROFILES_KEY = 'pickup-profiles', THEME_KEY = 'pickup-theme';
const PENDING_KEY = 'pickup-pending', FLIP_KEY = 'pickup-flipped', DEVICE_KEY = 'pickup-device';
const stored = key => { try { return localStorage.getItem(key); } catch { return null; } };
// This laptop's name in state.seen: the last of its changes the shared copy holds.
const DEVICE = stored(DEVICE_KEY) || Math.random().toString(36).slice(2, 10);
try { localStorage.setItem(DEVICE_KEY, DEVICE); } catch {}
let rosterView = 'arrive'; // Check in shows one list at a time, To arrive or Here: this laptop only
let flipped = stored(FLIP_KEY) === '1'; // which team shows on the left: this laptop only, never shared
// Sharing: every change to the session goes through act(), which also queues it here as
// [op, a, b, game number, sequence number] until a push to the server has taken it. Saved in its own key so a reload
// while offline keeps it. liveId and liveVer are the session and version the server last told us.
let pending = JSON.parse(stored(PENDING_KEY)) || [];
let liveId = null, liveVer = 0;
let replaying = false; // adopt() is laying pending changes back on: no dialogs, messages, sound or saves to the database
// lowercase name -> { name, games, points, avg }; the last copy is kept so profiles still show offline
let profiles = new Map();
try { profiles = new Map(JSON.parse(stored(PROFILES_KEY)).map(p => [p.name.toLowerCase(), p])); } catch {} // corrupt copy: start empty
let leaderMode = 'tonight'; // 'tonight' | 'alltime', the leaderboard toggle
let leaderKind = 'all'; // 'all' or a player type, the leaderboard filter
let kindPick = null; // the player whose type picker is open
let db = 'connecting'; // 'online' | 'offline' | 'locked' (needs the organizer passcode)

function load() {
  if (GUEST) return newSession(); // a guest never reads, or writes, a saved session
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s) { fresh = false; return tidy(s); }
  } catch {}
  return newSession();
}

// A saved or shared session, brought up to the current shape.
function tidy(s) {
  delete s.roster; // replaced by the database
  delete s.log; // never read
  delete s.flipped; // per laptop now
  const st = { expected: [], unsynced: [], kinds: [], seen: {}, startedAt: Date.now(), ...s };
  st.date ??= sessionDate(st.startedAt); // saved before sessions had a date
  seatTeams(st.game); // saved before every called player had a team
  // Every count becomes a number: saved before shots were tracked (missing, so 0), and the shared copy is
  // pushed by other laptops and not checked field by field on the server, so nothing but a number is
  // ever drawn where a number goes (these aren't escaped).
  const num = x => Number(x) || 0;
  st.game.number = Math.max(1, num(st.game.number));
  for (const c of [...st.game.onCourt, ...(st.game.subbedOut ?? [])]) {
    Object.assign(c, { points: num(c.points), fgm: num(c.fgm), fga: num(c.fga), log: Array.isArray(c.log) ? c.log.map(num) : [] });
  }
  for (const p of st.players) {
    Object.assign(p, { games: num(p.games), totalPoints: num(p.totalPoints), fgm: num(p.fgm), fga: num(p.fga), wins: num(p.wins), losses: num(p.losses), readyAt: num(p.readyAt) });
    if (p.turns !== undefined) p.turns = num(p.turns); // absent: the queue uses games (Queue.turn)
  }
  return st;
}

function save() {
  if (GUEST) return;
  try { localStorage.setItem(KEY, JSON.stringify(state)); localStorage.setItem(PENDING_KEY, JSON.stringify(pending)); saved = true; }
  catch { saved = false; flash('Could not save. Changes will be lost if the page is refreshed.'); }
}

function commit() { save(); render(); }

const flash = text => { if (!replaying) $('msg').textContent = text; };
const ask = text => replaying || confirm(text); // a replayed change was already confirmed
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
// Play has started: the clock has run, someone scored, or someone was subbed off (a clock reset must
// not reopen Fill and Pick, or a subbed-off player could be called back and counted twice).
const locked = () => state.game.started || !!state.game.subbedOut?.length || Queue.played(state.game).some(c => c.points > 0);
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
const kindClass = name => (kindOf(name) ? `k-${esc(kindOf(name).toLowerCase())}` : 'unset');
// A tag for a type itself: History shows the type a game was played under, not today's.
const kindSpan = k => (KINDS.includes(k) ? `<span class="kt k-${k.toLowerCase()}" title="${esc(kindLabel(k))}">${KIND_SHORT[k]}</span>` : '');
const kindTag = name => kindSpan(kindOf(name));
// A tag that opens the picker; a player with no type shows a faint "Type".
const kindBtn = name => `<button type="button" class="kt ${kindClass(name)}" data-action="pickKind" data-name="${esc(name)}" data-arg=""
  title="${esc(kindLabel(kindOf(name)) ?? 'Set type')}" aria-label="${kindOf(name) ? `${esc(name)} is ${esc(kindLabel(kindOf(name)))}. Change type` : `Set type for ${esc(name)}`}">${kindShort(name) || 'Type'}</button>`;
const kindPicker = name => `<div class="kpick" role="group" aria-label="Type for ${esc(name)}">${KINDS.map(k =>
  btn('setKind', name, kindLabel(k), { arg: k, pressed: kindOf(name) === k, cls: kindOf(name) === k ? 's' : 'o s' })).join('')}${
  kindOf(name) ? `<button type="button" class="xbtn" data-action="setKind" data-name="${esc(name)}" data-arg="" aria-label="Clear type">&times;</button>` : ''}</div>`;
function themeLabel() {
  const label = `Switch to ${document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'} mode`;
  $('themeBtn').title = label;
  $('themeBtn').setAttribute('aria-label', label);
}
function closeKindPick() { kindPick = null; renderTonight(); renderLeaders(); }
const playerNamed = name => state.players.find(p => p.name.toLowerCase() === name.toLowerCase());
const pct = (made, tried) => `${Math.round((made / tried) * 100)}%`;
const avgText = name => {
  if (!profiles.size) return '';
  const p = profileOf(name);
  return p?.games ? `AVG ${p.avg.toFixed(1)}` : 'NEW';
};
const btn = (action, name, label, { arg = '', pressed, cls = 'o s', disabled } = {}) =>
  `<button class="btn ${cls}" data-action="${action}" data-name="${esc(name)}" data-arg="${arg}"` +
  `${pressed === undefined ? '' : ` aria-pressed="${pressed}"`}${disabled ? ' disabled' : ''}>${label}</button>`;

// ---- tabs: the island. A tab hides every panel but its own and scrolls to the top ----

const TABS = GUEST ? ['leaders', 'history'] : ['home', 'checkin', 'queue', 'board', 'leaders', 'history'];
const island = $('island'), thumb = island.querySelector('.island-thumb');
// A guest's island has two tabs. A hidden one is never the selected one: the markup selects Home, and
// place() puts the highlight on whichever tab says it is selected.
const tabs = [...island.querySelectorAll('[role="tab"]')].filter(t => {
  t.hidden = !TABS.includes(t.dataset.tab);
  if (t.hidden) t.setAttribute('aria-selected', 'false');
  return !t.hidden;
});
let active = TABS[0];

function place() {
  const b = island.querySelector('[aria-selected="true"]');
  if (!b) return;
  thumb.style.width = b.offsetWidth + 'px';
  thumb.style.transform = `translateX(${b.offsetLeft}px)`;
}
function show(name) {
  if (!TABS.includes(name)) name = TABS[0];
  const changed = name !== active;
  active = name;
  tabs.forEach(t => { const on = t.dataset.tab === name; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; });
  document.querySelectorAll('.tabpanel').forEach(p => { p.hidden = p.id !== name; });
  place();
  island.querySelector('[aria-selected="true"]').scrollIntoView({ block: 'nearest', inline: 'nearest' });
  if (changed) window.scrollTo(0, 0);
  if (name === 'home') loadGuestCode();
  if (name === 'checkin') renderTonight();
  if (name === 'leaders') renderLeaders();
  if (name === 'history') renderHistory();
}
function route() {
  let name = '';
  try { name = decodeURIComponent(location.hash.slice(1)); } catch {} // a malformed hash like #% opens Home
  show(name);
}
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

const init = body => (body === undefined ? {} : {
  method: 'POST', body: JSON.stringify(body),
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${stored(PASS_KEY) || ''}` },
});

// A 401: an organizer is asked for the passcode, a guest for this week's guest code.
function refused() { if (GUEST) lockGuest(); else { db = 'locked'; askPasscode(); } return new Locked(); }

async function api(path, body) {
  if (location.protocol === 'file:') throw new Error('opened as a file');
  const res = await fetch(path, init(body));
  if (res.status === 401) throw refused();
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

// /api/live and /api/sessions answer with their own JSON, not the profiles list api() expects.
// Resolves { status, data }: 200 and 409 carry a session, 204 nothing.
async function liveFetch(path, body) {
  if (location.protocol === 'file:') throw new Error('opened as a file');
  const res = await fetch(path, init(body));
  if (res.status === 401) throw refused();
  if (!res.ok && res.status !== 409) throw new Error(`HTTP ${res.status}`);
  return { status: res.status, data: res.status === 204 ? null : await res.json() };
}

// Finished games wait in state.unsynced (saved in this browser) until the database has them.
// One sync at a time: an overlapping one could send the same game twice or shift the wrong one.
let syncing = false, syncAgain = false;
async function sync() {
  if (syncing) { syncAgain = true; return; }
  syncing = true;
  try {
    await api('/api/profiles');
    // Games and types go up only once the shared copy holds them, then come off the list as a change
    // (posted, kindPosted) so every laptop sees them done. Two laptops posting the same game is
    // harmless: UNIQUE (session, game, name).
    if (shared()) {
      for (const g of [...state.unsynced]) {
        try { await api('/api/results', g); }
        catch (e) { if (!(e instanceof Rejected)) throw e; flash(`The database rejected a game: ${e.message}`); }
        act('posted', g.session, g.game);
      }
      for (const k of [...state.kinds]) {
        try { await api('/api/kind', k); }
        catch (e) { if (!(e instanceof Rejected)) throw e; flash(`The database rejected a player type: ${e.message}`); }
        act('kindPosted', k.name, k.kind);
      }
    }
  } catch (e) {
    if (!(e instanceof Rejected || e instanceof Locked)) db = 'offline';
  } finally {
    syncing = false;
    if (syncAgain) { syncAgain = false; sync(); }
  }
  render();
}

// ---- sharing: the server keeps the session with a version; each laptop pushes after a change and
// polls every 2 seconds, so a change shows on the others within about 3. ----
// ponytail: whole-state pushes, a 2-second poll and last-write-wins on the same field; Durable Objects
// or WebSockets if the night ever needs instant updates or per-field merging.
// A push whose reply is lost still reached the server. state.seen[device] is the last sequence number of
// this laptop's changes that a copy holds, so adopt() drops the waiting ones the copy already has.

// Changes about the night as a whole: these still apply when the game has moved on, or a new session
// started. A game's own changes (points, clock, lineup) are dropped by adopt() if the game number differs.
const SESSION_OPS = new Set(['checkIn', 'uncheck', 'removeName', 'addNames', 'done', 'undoDone', 'setKind', 'posted', 'kindPosted', 'fixGame']);
// The shared copy holds everything this laptop has done (nothing waiting, and the server knows its session).
const shared = () => liveId === state.startedAt && !pending.length;

// The one way to change the session: run the action, queue it for the server, save, draw, push.
// Returns false when the action did nothing, so nothing is queued. Args must be plain JSON: adopt()
// replays them on a newer copy, from the data alone.
function act(op, a, b) {
  if (GUEST && !VIEW_OPS.has(op)) return false; // read-only: nothing is changed, queued or pushed
  const game = state.game.number; // before the action: End game moves on to the next
  if (actions[op](a, b) === false) return false;
  if (op === 'newSession') { pending = []; fresh = false; } // the old session's changes mean nothing to the new one; this one is meant
  else {
    if (op === 'teamName' && pending.length > inflight && pending.at(-1)[0] === op && pending.at(-1)[1] === a) pending.pop(); // typing: keep the last
    const seq = Math.max(pending.at(-1)?.[4] ?? 0, state.seen[DEVICE] ?? 0) + 1; // up across reloads and sessions
    state.seen[DEVICE] = seq;
    pending.push([op, a, b, game, seq]);
  }
  commit();
  pushLive();
}

// One push at a time, rerun if more changes came while it was out (same pattern as sync).
let pushing = false, pushAgain = false, inflight = 0; // inflight: how many pending changes the push in the air holds
async function pushLive() {
  if (fresh) return; // not joined yet: the poll decides whether this laptop's empty session may be pushed
  if (pushing) { pushAgain = true; return; }
  pushing = true;
  try {
    do {
      pushAgain = false;
      inflight = pending.length;
      const id = state.startedAt;
      const r = await liveFetch('/api/live', { id, date: state.date, version: id === liveId ? liveVer : 0, state });
      if (id === state.startedAt) { // else a new session started meanwhile; the rerun pushes it
        if (r.status === 409) adopt(r.data); // someone got there first: take theirs, lay ours back on top
        else { liveId = id; liveVer = r.data.version; fresh = false; pending.splice(0, inflight); save(); }
      }
      inflight = 0;
      if (db !== 'locked') db = 'online';
    } while (pushAgain);
    if (shared() && (state.unsynced.length || state.kinds.length)) sync();
  } catch (e) {
    if (!(e instanceof Locked)) db = 'offline'; // pending stays; the poll tries again
  } finally {
    pushing = false;
    inflight = 0;
    renderDot();
  }
}

// Take the server's copy of the session, then lay this laptop's unsent changes back on top.
function adopt(server) {
  const old = state, switched = server.id !== old.startedAt;
  state = tidy(server.state);
  liveId = server.id;
  liveVer = server.version;
  fresh = false;
  pending = pending.filter(c => !(c[4] <= (state.seen[DEVICE] ?? 0))); // the copy already holds these
  if (switched) {
    // Another laptop started a new session. ponytail: game changes made here are dropped and the
    // list, check-ins and player types carry over; games ended here that the server never saw ride along.
    pending = pending.filter(c => SESSION_OPS.has(c[0]));
    state.unsynced.push(...old.unsynced.filter(u => !state.unsynced.some(x => x.session === u.session && x.game === u.game)));
    needsChoice = [];
    sel = null;
  }
  // Each change runs again with confirm answered yes. One recorded on another game is stale; one that
  // fails or finds nothing to do is too. Both are dropped.
  replaying = true;
  pending = pending.filter(([op, a, b, game, seq]) => {
    if (!SESSION_OPS.has(op) && game !== state.game.number) return false;
    try { if (actions[op](a, b) === false) return false; } catch { return false; }
    if (seq) state.seen[DEVICE] = Math.max(state.seen[DEVICE] ?? 0, seq);
    return true;
  });
  replaying = false;
  save();
  render(); // keepFocus; renderBoard leaves a team-name box that has focus alone
  if (switched) flash('Another laptop started a new session. Switched to it.');
  if (pending.length) pushLive();
  else if (state.unsynced.length || state.kinds.length) sync();
}

// Every 2 seconds while the page is visible: has the server's session changed? It is also how a
// laptop that was offline catches up, and how a fresh page joins (liveId is null until it has).
let polling = false;
async function poll() {
  if (polling || pushing || document.hidden || db === 'locked') return;
  polling = true;
  const was = db;
  try {
    const { status, data } = await liveFetch(`/api/live?id=${liveId ?? 0}&v=${liveVer}`);
    if (pushing) return; // a push started meanwhile and this reply may predate it
    if (db !== 'locked') db = 'online';
    // Nothing newer: send what is waiting, or a session the server lacks (no session at all: a fresh
    // laptop creates it). A fresh laptop never pushes over a session the server has, however new its id.
    if (status === 204 || (data.id < state.startedAt && !fresh)) {
      if (status === 204) fresh = false;
      if (pending.length || state.startedAt !== liveId) pushLive();
    } else if (data.id !== liveId || data.version > liveVer) adopt(data);
    if (was !== 'online' && shared() && (state.unsynced.length || state.kinds.length)) sync(); // back from offline
  } catch (e) {
    if (!(e instanceof Locked)) db = 'offline';
  } finally {
    polling = false;
    renderDot();
  }
}

// ---- name autosuggest (check-in and tonight's list) ----

let needsChoice = []; // pasted names that match several players: { query, choices }

const onList = name => state.expected.some(n => n.toLowerCase() === name.toLowerCase());
const canUncheck = p => !p.games && !Queue.played(state.game).some(c => c.name === p.name);
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

// ---- actions (each change to the session; return false when nothing changed or it is only a view).
// Run them through act(), never directly, so every laptop sees the change. They take plain-data
// arguments and read nothing but state, so adopt() can replay them. ----

const actions = {
  fill() { if (locked()) return false; Queue.fill(state.players, state.game, SPOTS); seatTeams(); },
  pick(name) { if (locked()) return false; Queue.pick(state.game, name, SPOTS); seatTeams(); },
  sitOut(name) { if (locked()) return false; Queue.sitOut(state.game, name); },
  remove(name) { if (locked()) return false; Queue.remove(state.game, name); },
  done: name => { player(name).present = false; }, // no confirm: Undo puts them back
  undoDone: name => { player(name).present = true; },
  leaderMode(_, mode) { leaderMode = mode; keepFocus(renderLeaders); return false; }, // a view choice, not saved
  leaderKind(_, kind) { leaderKind = kind; keepFocus(renderLeaders); return false; }, // so is the filter
  checkIn(raw) {
    const typed = cleanName(raw);
    if (!typed) return false;
    const p = playerNamed(typed);
    if (p) { flash(p.present ? `${p.name} is already checked in.` : `${p.name} is done for the night.`); return false; }
    const name = profileOf(typed)?.name ?? typed; // keep the database's spelling
    // late: arrived once play has begun. They lead the next game, then join the normal rotation (Queue.endGame).
    const late = state.game.number > 1 || locked();
    state.players.push({ name, games: 0, turns: 0, readyAt: Date.now(), present: true, totalPoints: 0, fgm: 0, fga: 0, wins: 0, losses: 0, ...(late && { late }) });
    flash(`${name} checked in.`);
  },
  // Undo a mistaken check-in: back to To arrive. Only before they've played (canUncheck), since
  // it forgets the player for tonight, games and points included.
  uncheck(name) {
    const p = player(name);
    if (!p || !canUncheck(p)) return false;
    state.players = state.players.filter(x => x !== p);
    addToList(name);
    flash(`${name} is back on To arrive.`);
  },
  removeName: name => { state.expected = state.expected.filter(n => n !== name); },
  // Names go on the list together; the database hears of them when this laptop makes the change.
  addNames(names) {
    const had = state.expected.length;
    for (const n of names) addToList(n);
    if (state.expected.length === had) return false;
    if (!replaying) saveList();
  },
  // The answer to "which one is coming?": the choice is a view, adding the name is the change.
  choose(name, query) {
    needsChoice = needsChoice.filter(c => c.query !== query);
    if (act('addNames', [name]) === false) render();
    return false;
  },
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

  // want is 'start' or 'pause' (the Start button says which), so replaying it can't flip a clock another
  // laptop already started or paused; with none it toggles.
  startPause(_, want) {
    const g = state.game, start = (want || (g.endsAt ? 'pause' : 'start')) === 'start';
    if (!start && g.endsAt) { g.remainingMs = remaining(); g.endsAt = null; }
    else if (start && !g.endsAt && ready() && g.remainingMs > 0) { g.endsAt = Date.now() + g.remainingMs; g.started = true; }
    else return false;
  },

  // The clock ran out (every laptop sees it, each sounds the buzzer). Nothing to do if it hasn't.
  clockEnd() {
    const g = state.game;
    if (!g.endsAt || g.endsAt > Date.now()) return false;
    Object.assign(g, { endsAt: null, remainingMs: 0 });
  },

  resetClock() {
    if (!ask(`Reset the clock to ${GAME_MINUTES}:00?`)) return false;
    Object.assign(state.game, { remainingMs: GAME_MS, endsAt: null, started: false });
  },

  endGame() {
    const g = state.game;
    if (!g.onCourt.length) return false;
    if (!ask(`End game ${g.number}? ${g.homeName} ${score('home')}, ${g.awayName} ${score('away')}.`)) return false;
    const lineup = nextLineup(Date.now()); // before the game is counted, as Up next showed it
    Queue.endGame(state.players, g, Date.now());
    state.unsynced.push({
      session: state.startedAt, date: state.date, game: g.number,
      rows: Queue.played(g).map(c => ({ name: c.name, points: c.points, fgm: c.fgm, fga: c.fga, won: Queue.won(g, c), team: { home: 0, away: 1 }[c.team] ?? null, kind: kindOf(c.name) })),
    });
    state.game = newGame(g.number + 1);
    state.game.onCourt = lineup.map(x => ({ ...Queue.seat(x.name), team: x.team })); // Up next takes the court
    if (replaying) return; // the game ended on another laptop's screen; leave this one where it is
    if (document.fullscreenElement) document.exitFullscreen();
    go('queue');
  },
  // End game queued the result; once the database has it, any laptop's sync takes it off the list.
  posted(session, game) {
    const had = state.unsynced.length;
    state.unsynced = state.unsynced.filter(u => !(u.session === session && u.game === game));
    if (state.unsynced.length === had) return false;
  },
  // A finished game fixed in History (the database already has the fix): tonight's totals take the
  // old rows off and the new ones on. Players not checked in tonight have no totals here to fix.
  fixGame({ session, old }, rows) {
    if (session !== state.startedAt) return false;
    const count = (r, sign) => {
      const p = state.players.find(p => p.name.toLowerCase() === r.name.toLowerCase());
      if (!p) return;
      p.games += sign; p.totalPoints += sign * r.points;
      p.turns = Queue.turn(p) + sign; // ponytail: a fixed game counts a whole turn, half-game subs aside
      p.fgm = (p.fgm ?? 0) + sign * r.fgm; p.fga = (p.fga ?? 0) + sign * r.fga;
      if (r.won === 1) p.wins = (p.wins ?? 0) + sign;
      if (r.won === 0) p.losses = (p.losses ?? 0) + sign;
    };
    old.forEach(r => count(r, -1));
    rows.forEach(r => count(r, 1));
  },
  askGuest() { openGuestDlg(); return false; }, // the guest view's way back to the code prompt
  // History's Edit: opens the game in the fix dialog. A view until it is saved.
  editGame(session, game) { openFix(histData.get(Number(session)), Number(game)); return false; },
  kindPosted(name, kind) {
    const had = state.kinds.length;
    state.kinds = state.kinds.filter(k => !(k.name === name && k.kind === kind)); // a newer tap for this player stays
    if (state.kinds.length === had) return false;
  },

  goTab(_, tab) { go(tab); return false; },
  // Light or dark, remembered on this device; the page applies it before it paints. Dark by default.
  theme() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(THEME_KEY, next); } catch {}
    themeLabel();
    return false;
  },
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

  // Start a new session opens a dialog for its date, Thursday by default; any date will do.
  askSession() {
    $('sessionDate').value = sessionDate(Date.now());
    $('sessionDlg').returnValue = '';
    $('sessionDlg').showModal();
    return false;
  },
  // The dialog's answer. It also runs with whatever other code passes in, so a date that isn't a real
  // YYYY-MM-DD is refused: the server would reject it, and the push would never get through.
  newSession(date) {
    const [y, m, d] = String(date).split('-').map(Number);
    if (!/^\d{4}-\d\d-\d\d$/.test(date) || localDate(new Date(y, m - 1, d).getTime()) !== date) return false;
    state = { ...newSession(), date, unsynced: state.unsynced, kinds: state.kinds };
    needsChoice = [];
  },

  // From the queue diagram: a waiting or lineup player in for someone on court. No confirm: swapping
  // back undoes it. They've now played this game, so they give up any saved Up next spot; the next
  // in fairness order takes it.
  sub(outName, inName) {
    const g = state.game;
    Queue.sub(g, outName, inName, locked());
    if (g.plan) g.plan = g.plan.filter(x => x.name !== inName);
  },

  // Check in: switch between the To arrive and Here lists. A view, not a shared change.
  rosterView(_, view) { rosterView = view || (rosterView === 'here' ? 'arrive' : 'here'); keepFocus(renderTonight); return false; },

  // Switch sides: which team shows on the left. This laptop only, so a view, not a shared change.
  flip() {
    flipped = !flipped;
    try { localStorage.setItem(FLIP_KEY, flipped ? '1' : ''); } catch {}
    keepFocus(renderBoard);
    return false;
  },

  // The Up next lineup: each edit freezes it as shown, then changes it (editPlan).
  // A waiting player in: pinned, and whoever they replaced is kept out (the original, if out was a pin too).
  planSwap: (out, inn) => editPlan(l => { const x = l.find(y => y.name === out); Object.assign(x, { name: inn, pin: true, for: x.for ?? out }); }),
  planTeams: (a, b) => editPlan(l => { const x = l.find(y => y.name === a), y = l.find(z => z.name === b); [x.team, y.team] = [y.team, x.team]; }),
  planMove: (name, team) => editPlan(l => { if (l.filter(x => x.team === team).length < TEAM_SIZE) l.find(x => x.name === name).team = team; }),
  // On court: two players on opposite teams swap sides; a player goes to a team.
  swapTeams(a, b) { const x = seatOf(a), y = seatOf(b); [x.team, y.team] = [y.team, x.team]; },
  setTeam(name, team) { seatOf(name).team = team; },
  teamName(side, value) { state.game[side + 'Name'] = value || (side === 'home' ? 'Home' : 'Away'); },

  // Player type: a tag opens the picker under that row; picking saves it, and sync sends it.
  pickKind(name) { kindPick = kindPick === name ? null : name; keepFocus(() => { renderTonight(); renderLeaders(); }); return false; },
  setKind(name, kind) {
    state.kinds = [...state.kinds.filter(k => k.name !== name), { name, kind: kind || null }];
    kindPick = null;
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
  if (b) act(b.dataset.action, b.dataset.name, b.dataset.arg);
});

autosuggest($('listAdd'), $('listSug'), name => {
  const p = playerNamed(name);
  if (p) return flash(p.present ? `${p.name} is already checked in.` : `${p.name} is done for the night.`);
  if (onList(name)) return flash(`${name} is already on the list.`);
  act('addNames', [name]);
}, flash);

// Start a new session: the date picked in the dialog.
$('sessionDlg').addEventListener('close', () => {
  if ($('sessionDlg').returnValue === 'start') act('newSession', $('sessionDate').value);
});

// Paste: each line resolves like typing does; names shared by several players wait for a choice.
$('pasteDlg').addEventListener('close', () => {
  if ($('pasteDlg').returnValue !== 'add') return;
  const people = knownPeople(), names = [];
  for (const line of $('pasteText').value.split('\n')) {
    const r = Names.resolve(line, people);
    if (r.name || r.fresh) names.push(r.name || r.fresh);
    else if (r.choices && !needsChoice.some(c => Names.norm(c.query) === Names.norm(line))) {
      needsChoice.push({ query: cleanName(line), choices: r.choices });
    }
  }
  $('pasteText').value = '';
  if (act('addNames', names) === false) render(); // nothing new, but the names to choose between still show
});

for (const t of ['home', 'away']) {
  $(t + 'Name').oninput = e => act('teamName', t, e.target.value);
}

document.addEventListener('keydown', e => { if (e.key === 'Escape' && kindPick) closeKindPick(); });
document.addEventListener('keydown', e => {
  if (e.code !== 'Space' || active !== 'board' || ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
  e.preventDefault();
  act('startPause', '', state.game.endsAt ? 'pause' : 'start');
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
// game.plan. Only the edits hold: a player put in by hand (pin) stays, the player they replaced
// (for) stays out, and teams are remembered. Everyone else is recomputed, so a late arrival with
// fewer games still gets in ahead of someone on court. End game seats this lineup on court.
function nextLineup(now) {
  const g = state.game, plan = g.plan ?? [];
  const list = plan.filter(x => x.pin && player(x.name)?.present && !seatOf(x.name)).map(x => ({ ...x })); // called onto the court since: the pin is spent
  const out = new Set(list.map(x => x.for));
  const fair = Queue.nextGame(state.players, g, SPOTS + out.size, now).map(p => p.name).filter(n => !out.has(n));
  for (const name of fair) if (list.length < SPOTS && !list.some(x => x.name === name)) list.push({ name, team: plan.find(x => x.name === name)?.team ?? null });
  const n = t => list.filter(x => x.team === t).length;
  for (const x of list) if (!x.team) x.team = n('away') < n('home') ? 'away' : 'home';
  return list;
}
// An edit to Up next freezes the lineup as shown, then changes it (the plan actions).
function editPlan(fn) { const g = state.game; g.plan = nextLineup(Date.now()); fn(g.plan); }

// Home: one button for the next step of the night (Check in players, Fill the court,
// Start game N, Back to game N), next to Standby on TV.
function renderHome() {
  const g = state.game, present = state.players.some(p => p.present), started = g.started || !!g.endsAt;
  $('homeNext').textContent = !present ? 'Check in players'
    : started ? `Back to game ${g.number}` : ready() ? `Start game ${g.number}` : 'Fill the court';
  $('homeNext').dataset.arg = !present ? 'checkin' : started || ready() ? 'board' : 'queue';
  $('homeDate').textContent = `Session: ${dateLabel(state.date)}`;
  const gc = guestCodeInfo?.until > Date.now() ? guestCodeInfo : null;
  $('guestCodeText').textContent = gc ? gc.code : '------';
  $('guestCodeNote').textContent = gc ? `Changes ${dateLabel(localDate(gc.until))}` : 'Needs a connection';
}
// This week's guest code (GET /api/guest-code, organizers only): shown on Home for players to type in.
// Fetched again once the week it is for is over.
let guestCodeInfo = null;
async function loadGuestCode() {
  if (GUEST || guestCodeInfo?.until > Date.now()) return;
  try { guestCodeInfo = (await liveFetch('/api/guest-code')).data; } catch {}
  renderHome();
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
    const p = player(name), picked = sel?.name === name && sel.src === src;
    const pr = profileOf(name); // all-time, from the database
    const notes = [...(pr?.games ? [`${pr.avg.toFixed(1)} PPG`, ...(pr.fga ? [`${pct(pr.fgm, pr.fga)} FG`] : [])] : []), plural(Queue.turn(p), 'game')];
    if (g.satOut.includes(name)) notes.push('sitting out');
    if (passed.has(name)) notes.push('passed over');
    return `<div class="qn${cls}${picked ? ' picked' : ''}" data-p="${esc(name)}" data-src="${src}"${p.present ? ' draggable="true"' : ''}
      tabindex="0" role="button" aria-pressed="${picked}" title="${esc(name)}"><b>${clover(name)}${esc(shortName(name))}</b><span class="qsub">${kindTag(name)}<small>${notes.join(' · ')}</small></span>${
      picked ? `<span class="qacts">${acts(name, src)}</span>` : ''}</div>`;
  };
  const group = (label, names, src, cls = '', mark = '', zone = '') => names.length || zone
    ? `<div class="qgrp"${zone ? ` data-zone="${zone}"` : ''}><p class="grp">${mark}${esc(label)}</p>${names.length
      ? `<div class="qnodes">${names.map(n => node(n, src, cls)).join('')}${zone ? '<div class="qslot" aria-hidden="true"></div>'.repeat(Math.max(0, TEAM_SIZE - names.length)) : ''}</div>`
      : '<p class="zone">Drag players here</p>'}</div>` : ''; // a team's open places show as empty slots
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
  for (const p of order) if (!nextSet.has(p.name)) tiers.set(Queue.turn(p), [...(tiers.get(Queue.turn(p)) ?? []), p.name]); // by turns: the rotation's count
  const waiting = [...tiers].sort((a, b) => a[0] - b[0]).map(([n, names]) => group(plural(n, 'game'), names, 'wait')).join('')
    + group('Done for the night', state.players.filter(p => !p.present).map(p => p.name), 'done', ' out');

  // Column headers in the Check in board's idiom: a number, a serif title, a small note.
  const head = (n, title, note) => `<span class="kn">0${n}.</span><h3>${title}</h3><span class="kc">${esc(note)}</span>`;
  glide($('qmap'), el => { el.innerHTML = col('court', head(1, 'On court', `Game ${g.number}`) + fill, court, '') + arrow
    + col('next', head(2, 'Up next', full ? `Game ${g.number + 1}` : 'fills open spots'), upnext, 'Nobody to call.', full ? '' : 'line') + arrow
    + col('wait', head(3, 'Waiting', order.filter(p => !nextSet.has(p.name)).length) + btn('fullscreen', '', 'Full screen', { arg: 'qmap' }), waiting, 'Nobody waiting.', 'line'); });
}

// Motion for the diagram: after a redraw each box glides from where it was to where it is now,
// and a box that wasn't there fades in. Skipped when the system asks for reduced motion.
function glide(el, draw) {
  if (typeof matchMedia !== 'function' || matchMedia('(prefers-reduced-motion: reduce)').matches) return draw(el);
  const was = new Map([...el.querySelectorAll('[data-p]')].map(n => [n.dataset.p, n.getBoundingClientRect()]));
  draw(el);
  const ease = { duration: 340, easing: 'cubic-bezier(.2,.8,.2,1)' };
  for (const n of el.querySelectorAll('[data-p]')) {
    const a = was.get(n.dataset.p), b = n.getBoundingClientRect(), dx = a ? a.left - b.left : 0, dy = a ? a.top - b.top : 0;
    if (!a) n.animate([{ opacity: 0, transform: 'scale(.9)' }, {}], ease);
    else if (Math.abs(dx) > 1 || Math.abs(dy) > 1) n.animate([{ transform: `translate(${dx}px,${dy}px)` }, {}], ease);
  }
}

const qmap = $('qmap');
// Drag events can target the text inside a box (Firefox), so look up from its element.
const hit = (e, s) => (e.target.nodeType === 1 ? e.target : e.target.parentElement)?.closest(s);
const teamIn = (src, name) => (src === 'court' ? seatOf(name)?.team : nextLineup(Date.now()).find(x => x.name === name)?.team);
// Two boxes, one after the other (drag one onto the other, or click both): sub, replace or swap.
// A sub can come from the waiting side or from the lineup.
// Returns false when the pair means nothing, so a drop can fall back to the area underneath.
function pair(a, aSrc, b, bSrc) {
  if (a === b || !player(a)?.present || !player(b)?.present) return false;
  const waits = src => src === 'wait';
  if (waits(aSrc) !== waits(bSrc)) { // a waiting player and someone on court or in the lineup
    const [w, other, oSrc] = waits(aSrc) ? [a, b, bSrc] : [b, a, aSrc];
    if (oSrc === 'court' && !seatOf(w)) return act('sub', other, w);
    if (oSrc === 'next' && !nextLineup(Date.now()).some(x => x.name === w)) return act('planSwap', other, w);
    return false;
  }
  if (aSrc !== bSrc && [aSrc, bSrc].every(s => s === 'court' || s === 'next')) { // someone in the lineup and someone on court: sub in now
    const [inn, out] = aSrc === 'next' ? [a, b] : [b, a];
    return seatOf(inn) ? false : act('sub', out, inn);
  }
  if (aSrc !== bSrc || waits(aSrc)) return false;
  const ta = teamIn(aSrc, a), tb = teamIn(bSrc, b);
  if (!ta || !tb || ta === tb) return false;
  return act(aSrc === 'court' ? 'swapTeams' : 'planTeams', a, b); // swap sides
}
// Drop a player (from box src) on a box or an area of the diagram.
function dropOn(name, src, t) {
  if (!player(name)?.present) return;
  if (t.dataset.p && pair(name, src, t.dataset.p, t.dataset.src) !== false) return;
  const zone = (t.dataset.p ? t.closest('[data-zone]') : t)?.dataset.zone;
  if (!zone) return;
  if (zone.startsWith('next-')) { if (src === 'next') act('planMove', name, zone.slice(5)); return; } // lineup: switch team
  const seat = seatOf(name);
  if (zone === 'line') { if (seat && src === 'court') act('remove', name); return; } // back in line
  if (src === 'next') return; // onto a team's area: a lineup player subs in by landing on someone
  if (seat?.team !== zone && teamFull(zone)) return;
  if (!seat) { if (act('pick', name) === false || !seatOf(name)) return; } // onto a team: call them
  act('setTeam', name, zone);
}
qmap.addEventListener('dragstart', e => {
  const n = hit(e, '[data-p][draggable="true"]');
  if (n) { e.dataTransfer.setData('text/plain', `${n.dataset.src}:${n.dataset.p}`); e.dataTransfer.effectAllowed = 'move'; }
  if (n) requestAnimationFrame(() => n.classList.add('drag')); // after the browser has taken the drag image
});
qmap.addEventListener('dragend', () => qmap.querySelectorAll('.drag').forEach(x => x.classList.remove('drag')));
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
  // All-time counts each game under the type it was played under (byKind); a copy of the profiles
  // from before that existed falls back to today's type.
  const asRow = (name, p) => ({ name, games: p.games, totalPoints: p.points, fgm: p.fgm ?? 0, fga: p.fga ?? 0, wins: p.wins ?? 0, losses: p.losses ?? 0 });
  const allTime = () => [...profiles.values()].flatMap(p => leaderKind === 'all' ? [asRow(p.name, p)]
    : (p.byKind ?? [{ ...p, kind: kindOf(p.name) }]).filter(k => k.kind === leaderKind).map(k => asRow(p.name, k))).filter(p => p.games);
  const list = all ? allTime() : state.players.filter(p => leaderKind === 'all' || kindOf(p.name) === leaderKind);
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
      <td class="n">${rank ?? ''}</td><td class="who"><div><b title="${esc(p.name)}">${esc(p.name)}</b>${all && !GUEST ? kindBtn(p.name) : kindTag(p.name)}</div></td>${cell(p.games, 'r mono gm')}${all
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
  lb.innerHTML = GUEST && guestLocked ? `<p class="empty">The leaderboard needs this week's guest code. Ask an organizer for it.</p><div class="btns">${btn('askGuest', '', 'Enter the code', { cls: 's' })}</div>`
    : all && !profiles.size ? '<p class="empty">All-time stats need the database. Check the dot in the top bar.</p>'
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

// ---- history ----

// History: every session in the database, newest first, each a <details> that fetches its box
// scores the first time it opens. Online only; a failed fetch says so in one line.
const PER_COLUMN = 10; // rows in a column of a session's players table
const histNote = text => `<p class="empty">${esc(text)}</p>`;
async function renderHistory() {
  const box = $('historyList');
  try {
    const { data } = await liveFetch('/api/sessions');
    box.innerHTML = data.length ? data.map(s => `<details class="dd" data-id="${esc(s.id)}"><summary>${esc(s.date)}<span class="mono">${
      esc(plural(s.players, 'player'))} · ${esc(plural(s.games, 'game'))}</span></summary><div class="hbody"></div></details>`).join('')
      : histNote('No sessions yet.');
  } catch (e) { box.innerHTML = histNote(e instanceof Locked && GUEST ? "History needs this week's guest code." : 'History needs a connection.'); }
}
// A session opens to its players (a table, with each one's totals for the night) and its games, each a
// <details> headed by the result. A game lists its two sides, each sorted by points then name, with their
// totals: Home and Away when rows have a team (0 home, 1 away); for games saved before teams were kept,
// Winners and Losers from each row's won. With neither (a tie, very old data) it is one list.
const histData = new Map(); // session id -> its loaded detail, for Edit
// The type a row was played under; rows from before that was kept show today's.
const rowTag = r => (r.kind ? kindSpan(r.kind) : kindTag(r.name));
function sessionHtml(d) {
  const sum = rows => rows.reduce((t, r) => t + r.points, 0);
  const table = (label, rows, total, cls = '') => `<div class="tw${cls}"><table class="box"><thead><tr><th>${esc(label)}</th><th class="r">PTS</th><th class="r">FG</th></tr></thead><tbody>${
    rows.map(r => `<tr><td>${esc(r.name)}${rowTag(r)}</td><td class="r mono">${esc(r.points)}</td><td class="r mono">${esc(r.fgm)}/${esc(r.fga)}</td></tr>`).join('')}${
    total ? `<tr><td><b>Total</b></td><td class="r mono"><b>${esc(sum(rows))}</b></td><td></td></tr>` : ''}</tbody></table></div>`;
  const top = rows => [...rows].sort((a, b) => b.points - a.points || byName(a.name, b.name));
  const game = g => {
    const rows = g.rows, of = (key, v) => top(rows.filter(r => r[key] === v));
    const teamed = rows.length && rows.every(r => r.team === 0 || r.team === 1);
    const decided = rows.length && rows.every(r => r.won === 0 || r.won === 1) && of('won', 1).length && of('won', 0).length;
    const sides = teamed ? [['Home', of('team', 0)], ['Away', of('team', 1)]] : decided ? [['Winners', of('won', 1)], ['Losers', of('won', 0)]] : null;
    // The winning side gets a quiet highlight and a WIN watermark: its team's color, or green for Winners in
    // older games. A tie highlights neither side and marks both with a TIE watermark.
    const totals = sides?.map(([, list]) => sum(list)) ?? [];
    const win = !sides ? -1 : !teamed ? 0 : totals[0] === totals[1] ? -1 : totals[0] > totals[1] ? 0 : 1;
    const result = !sides ? plural(rows.length, 'player') : teamed ? `Home ${sum(sides[0][1])}, Away ${sum(sides[1][1])}` : `${sum(sides[0][1])}-${sum(sides[1][1])}`;
    return `<details class="dd"><summary>Game ${esc(g.game)} · ${esc(result)}</summary>${
      sides ? `<div class="sides">${sides.map(([label, list], i) => table(label, list, true, teamed && win < 0 ? ' tie' : i !== win ? '' : ` win${teamed ? ['', ' home', ' away'][i + 1] : ''}`)).join('')}</div>` : table('Player', top(rows), false)}${
      d.id === undefined || GUEST ? '' : `<div class="btns left">${btn('editGame', d.id, 'Fix this game', { arg: g.game })}</div>`}</details>`;
  };
  // Everyone who checked in, plus anyone in the results; one who never played has 0 games and dashes.
  const who = new Map([...d.participants, ...d.games.flatMap(g => g.rows.map(r => r.name))].map(n => [n, { games: 0, points: 0, fgm: 0, fga: 0, won: 0, lost: 0, kind: null }]));
  for (const r of d.games.flatMap(g => g.rows)) {
    const s = who.get(r.name);
    s.games++; s.points += r.points; s.fgm += r.fgm; s.fga += r.fga; s.won += r.won === 1; s.lost += r.won === 0;
    s.kind = r.kind ?? s.kind; // the type of their last game that night
  }
  const dash = '<td class="r mono">-</td>';
  const row = ([name, s]) => `<tr><td class="who"><div><b title="${esc(name)}">${esc(name)}</b>${rowTag({ name, kind: s.kind })}</div></td><td class="r mono gm">${esc(s.games)}</td>${
    s.games ? `<td class="r pts">${esc(s.points)}</td>` : dash}${
    s.fga ? `<td class="r mono fg${s.fga < MIN_FG_SHOTS ? ' few' : ''}"><small>${esc(s.fgm)}/${esc(s.fga)}</small> ${esc(pct(s.fgm, s.fga))}</td>` : dash}${
    s.won + s.lost ? `<td class="r mono">${esc(s.won)}-${esc(s.lost)}</td>` : dash}</tr>`;
  const ranked = [...who].sort(([an, a], [bn, b]) => b.points - a.points || b.games - a.games || byName(an, bn));
  // Columns of PER_COLUMN rows, side by side as on the leaderboard (.lb.split; stacked on a narrow page).
  const k = Math.ceil(ranked.length / PER_COLUMN);
  const column = i => `<div class="tw"><table><thead><tr><th>Player</th><th class="r gm">Games</th><th class="r">Points</th><th class="r">FG</th><th class="r">W-L</th></tr></thead><tbody>${
    ranked.slice(i * PER_COLUMN, (i + 1) * PER_COLUMN).map(row).join('')}</tbody></table></div>`;
  const players = who.size ? `<details class="dd"><summary>Players · ${esc(who.size)}</summary><div class="lb${k > 1 ? ' split' : ''}${k > 2 ? ' split3' : ''}" style="--k:${k}">${
    Array.from({ length: k }, (_, i) => column(i)).join('')}</div></details>` : histNote('No players on file.');
  return players + (d.games.map(game).join('') || histNote('No games saved.'));
}
// toggle doesn't bubble, so listen while it travels down. Only a session's own <details> (it has an id)
// fetches, once; opening a game or the players inside it leaves what is shown alone.
$('historyList').addEventListener('toggle', async e => {
  const d = e.target, body = d.querySelector?.('.hbody');
  if (!d.open || !d.dataset.id || !body || d.dataset.shown) return;
  try {
    const { data } = await liveFetch(`/api/sessions/${encodeURIComponent(d.dataset.id)}`);
    histData.set(data.id, data);
    body.innerHTML = sessionHtml(data);
    d.dataset.shown = '1';
  } catch { body.innerHTML = histNote('Could not load this session. History needs a connection.'); }
}, true);

// Fix a finished game: a dialog with one row per player (name, team, points, makes, attempts). Saving
// replaces the game in the database (/api/results/fix); removing every row deletes it. Tonight's totals
// follow as one shared change (fixGame). A teamed game's wins and losses are worked out again from the
// new points; otherwise each row keeps its own.
let fixing = null; // { session, date, game, rows } while the dialog is open
const fixRow = (r = {}) => `<tr data-name="${esc(r.name ?? '')}" data-won="${esc(r.won ?? '')}" data-kind="${esc(r.kind ?? '')}">
  <td><input class="in" name="n" list="fixNames" required maxlength="60" value="${esc(r.name ?? '')}" aria-label="Name"></td>
  <td><select class="in" name="t" aria-label="Team">${[['', '-'], ['0', 'Home'], ['1', 'Away']].map(([v, l]) =>
    `<option value="${v}"${String(r.team ?? '') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></td>
  ${['points', 'fgm', 'fga'].map(k => `<td><input class="in" name="${k}" type="number" min="0" max="200" step="1" required value="${esc(r[k] ?? 0)}" aria-label="${
    { points: 'Points', fgm: 'Makes', fga: 'Attempts' }[k]}"></td>`).join('')}
  <td><button type="button" class="xbtn" data-fix="del" aria-label="Remove this row">&times;</button></td></tr>`;
function openFix(d, game) {
  const g = d?.games.find(x => x.game === game);
  if (!g) return flash('Open the session again to fix this game.');
  fixing = { session: d.id, date: d.date, game, rows: g.rows };
  $('fixTitle').textContent = `Fix game ${game}, ${d.date}`;
  $('fixRows').innerHTML = g.rows.map(fixRow).join('');
  $('fixNames').innerHTML = [...profiles.values()].map(p => `<option value="${esc(p.name)}">`).join('');
  $('fixDlg').returnValue = '';
  $('fixDlg').showModal();
}
$('fixAdd').addEventListener('click', () => $('fixRows').insertAdjacentHTML('beforeend', fixRow()));
$('fixRows').addEventListener('click', e => { if (e.target.closest('[data-fix="del"]')) { e.target.closest('tr').remove(); fixCheck(); } });
const fixRead = () => [...$('fixRows').querySelectorAll('tr')].map(tr => {
  const v = n => tr.querySelector(`[name="${n}"]`);
  return { tr, v, name: cleanName(v('n').value), team: v('t').value === '' ? null : Number(v('t').value),
    points: Number(v('points').value), fgm: Number(v('fgm').value), fga: Number(v('fga').value) };
});
// The checks the inputs can't make on their own, on the field at fault. They run on every edit, so a
// corrected value clears its message and the browser's own check on Save sees the current state.
function fixCheck() {
  const seen = new Set();
  for (const r of fixRead()) {
    const key = r.name.toLowerCase();
    r.v('n').setCustomValidity(seen.has(key) ? 'This player is already in the game.' : '');
    seen.add(key);
    r.v('fgm').setCustomValidity(r.fgm > r.fga ? "Makes can't be more than attempts." : '');
    // Baskets are 2 or 3 points, so points sit between 2 and 3 per make (rows from before shots were kept have none).
    r.v('points').setCustomValidity(r.fga && (r.points < 2 * r.fgm || r.points > 3 * r.fgm) ? `With ${r.fgm} made, points are ${2 * r.fgm} to ${3 * r.fgm}.` : '');
  }
}
$('fixRows').addEventListener('input', fixCheck);
$('fixDlg').addEventListener('close', async () => {
  if ($('fixDlg').returnValue !== 'save' || !fixing) return;
  const f = fixing;
  fixing = null;
  const read = fixRead(), teamed = read.length && read.every(r => r.team !== null);
  const total = t => read.filter(r => r.team === t).reduce((n, r) => n + r.points, 0);
  const win = teamed && total(0) !== total(1) ? (total(0) > total(1) ? 0 : 1) : null;
  const rows = read.map(({ tr, v, ...r }) => ({ ...r,
    won: teamed ? (win === null ? null : Number(r.team === win)) : tr.dataset.won === '' ? null : Number(tr.dataset.won),
    kind: tr.dataset.name.toLowerCase() === r.name.toLowerCase() ? tr.dataset.kind || null : kindOf(r.name) }));
  try { await api('/api/results/fix', { session: f.session, date: f.date, game: f.game, rows }); }
  catch (e) {
    if (e instanceof Rejected) flash(`The database refused the fix: ${e.message}`);
    else if (!(e instanceof Locked)) flash('Fixing a game needs a connection. Nothing was changed.');
    return;
  }
  act('fixGame', { session: f.session, old: f.rows }, rows);
  flash(rows.length ? `Game ${f.game} fixed.` : `Game ${f.game} deleted.`);
  const body = $('historyList').querySelector(`details[data-id="${f.session}"] .hbody`);
  try {
    const { data } = await liveFetch(`/api/sessions/${f.session}`);
    histData.set(data.id, data);
    if (body) body.innerHTML = sessionHtml(data);
  } catch {}
});

// Check in layout: lists hold as many rows as fit between the top of the board and the bottom of
// the screen, and each board column takes as many lists as it needs. If those lists would come out
// too narrow, they get longer instead, so the page scrolls down, never sideways. Done for the night
// shares the second column. A phone stacks everything (see the styles).
function rosterLayout(n, cap = Infinity) { // cap: the largest scale to try
  const r = $('roster');
  const spread = rows => {
    let arrive = 1, arrivePer = rows;
    for (; arrive < 9; arrive++) {
      arrivePer = rows - (n.done ? Math.ceil(n.done / arrive) + 1 : 0); // Done takes its rows and a header
      if (arrivePer >= 1 && Math.ceil(n.arrive / arrive) <= arrivePer) break;
    }
    return { rows, arrive, arrivePer, here: Math.max(1, Math.ceil(n.here / rows)) };
  };
  if ($('checkin').hidden || r.clientWidth < 600) return { ...spread(Infinity), scale: 1.15 }; // laid out again when the tab shows
  const H = Math.floor(innerHeight - (r.getBoundingClientRect().top + scrollY) - 24);
  r.style.setProperty('--kh', `${H}px`);
  const here = rosterView === 'here', most = Math.max(6, here ? n.here : n.arrive + n.done + 1);
  // Only the list on show needs to fit: its columns side by side, at scale s.
  const fit = (rows, s) => { const l = spread(rows), cols = here ? l.here : l.arrive;
    return cols * (here ? COL_MIN : COL_ARRIVE) * s + (cols - 1) * 8 + 24 <= r.clientWidth && { ...l, scale: s }; };
  const screen = s => Math.max(6, Math.floor((H - HEAD_H) / (ROW_H * s)));
  for (const s of SCALES) { const l = s <= cap && fit(screen(s), s); if (l) return l; } // the biggest type that fits without scrolling
  for (let rows = screen(1); ; rows++) { // too many even at the smallest: longer columns, and the page scrolls
    const l = fit(rows, 1);
    if (l || rows >= most) return l || { ...spread(rows), scale: 1 };
  }
}
window.addEventListener('resize', () => renderTonight());
// Names are measured to decide their size; the web fonts can arrive after the first draw and are wider.
document.fonts?.ready.then(() => renderTonight());

const tag = name => (avgText(name) ? ` · ${avgText(name)}` : '');
// Team marker for labels: a filled square for Home, an outlined one for Away.
const mk = team => `<i class="mk ${team}" aria-hidden="true"></i>`;

// Check in: one full-width, full-height list at a time, with a button in its header to switch:
// 02 To arrive (shown first), with Done for the night at its foot, or 01 Here (everyone checked in, on court or
// not; who is on court is the Queue tab's job). Players are
// quiet one-line rows in rounded cards. Each list fills down to the bottom of the screen, then
// starts another column, and the board's columns share the page's width. A row shows its details
// (games tonight) until it is hovered or focused, then its button: Done, Undo, or the x that takes
// a name off the list. Check in, the main action, always shows; touch screens show every button.
const ROW_H = 40, HEAD_H = 70, COL_MIN = 200, COL_ARRIVE = 250; // at scale 1; a To arrive row also holds its Check in button
const SCALES = [1.7, 1.6, 1.5, 1.4, 1.3, 1.2, 1.1, 1]; // the roster's type and rows are as big as still fits the screen // px: .rrow height, a column's header and padding, the narrowest list
// New player: no games in the database before tonight (tonight's own games may already be saved
// there). Marked with a four-leaf clover. Unknown until the profiles have loaded.
// Four heart-shaped leaves meeting in the middle, and a stem.
const LEAF = 'M0 -.6C-1 -2.4-5.6-3.6-5.6-7.4a2.9 2.9 0 0 1 5.6-1.2a2.9 2.9 0 0 1 5.6 1.2C5.6-3.6 1-2.4 0-.6Z';
const CLOVER = `<svg viewBox="-12 -12 24 24" aria-hidden="true">${[45, 135, 225, 315].map(a => `<path transform="rotate(${a})" d="${LEAF}"/>`).join('')
  }<path d="M.6 .6C3 5 5.5 8 9.5 10.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
const isNew = name => profiles.size > 0 && (profileOf(name)?.games ?? 0) <= (playerNamed(name)?.games ?? 0);
const clover = name => (isNew(name) ? `<span class="clover" role="img" aria-label="New player" title="New player">${CLOVER}</span>` : '');
const briefName = name => { const w = name.split(' '); return w.length > 1 ? `${w[0]} ${w.at(-1)[0]}.` : name; }; // First L.
const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); // Test 2 before Test 10
function renderTonight() {
  const people = new Map(state.expected.map(n => [n.toLowerCase(), { n, name: profileOf(n)?.name ?? n }]));
  for (const p of state.players) people.set(p.name.toLowerCase(), { n: p.name, name: p.name });
  const groups = { here: [], arrive: [], done: [] };
  for (const x of people.values()) {
    const p = playerNamed(x.name);
    groups[!p ? 'arrive' : !p.present ? 'done' : 'here'].push({ ...x, p });
  }
  const row = ({ n, name, p }, key) => {
    const pr = profileOf(name);
    const record = !profiles.size ? '' : pr?.games
      ? ` · ${plural(pr.games, 'game')} · AVG ${pr.avg.toFixed(1)}${pr.fga ? ` · FG ${pct(pr.fgm, pr.fga)}` : ''}${
        pr.wins || pr.losses ? ` · ${pr.wins}-${pr.losses}` : ''}` : ' · First game';
    const type = kindOf(name) ? ` · ${esc(kindLabel(kindOf(name)))}` : '';
    const trail = key === 'arrive'
      ? btn('checkIn', name, 'Check in', { cls: 's' }) + `<button type="button" class="xbtn" data-action="removeName"
        data-name="${esc(n)}" data-arg="" aria-label="Remove ${esc(name)} from tonight's list">&times;</button>`
      : key === 'here' && !seatOf(name) ? btn('done', name, 'Done') + (canUncheck(p) ? `<button type="button" class="xbtn" data-action="uncheck"
        data-name="${esc(name)}" data-arg="" title="Back to To arrive" aria-label="Move ${esc(name)} back to To arrive">&larr;</button>` : '')
        : key === 'done' ? btn('undoDone', name, 'Undo') : '';
    return `<div class="rrow" title="${esc(name)}${type}${p ? ` · ${plural(p.games, 'game')} tonight` : ''}${record}">${kindBtn(name)}${clover(name)}<b>${esc(brief ? briefName(name) : name)}</b>${trail}</div>${
      kindPick === name ? kindPicker(name) : ''}`;
  };
  for (const k in groups) groups[k].sort((a, b) => byName(a.name, b.name));
  const count = k => groups[k].length;
  const counts = { here: count('here'), arrive: count('arrive'), done: count('done') };
  let L = rosterLayout(counts);
  // A list of players in columns of `per` rows, under an optional small header.
  const list = (k, per, cols, head = '') => {
    const cards = [];
    for (let j = 0; j < groups[k].length; j += per) cards.push(`<div class="rows">${groups[k].slice(j, j + per).map(x => row(x, k)).join('')}</div>`);
    return `<div class="sec s-${k}">${head && `<p class="sech">${head}<span>${count(k)}</span></p>`}<div class="cols" style="--c:${cols}">${cards.join('')}</div></div>`;
  };
  // The one list on show fills the board; the toggle in the middle of its header switches lists.
  const toggle = [['arrive', 'To arrive'], ['here', 'Here']].map(([v, label]) => btn('rosterView', '', `${label} · ${count(v)}`,
    { arg: v, pressed: rosterView === v, cls: rosterView === v ? 's' : 'o s' })).join('');
  const panel = (n, title, total, cols, body, empty) => `<div class="kcol" style="--c:${cols}"><div class="khead"><span class="kn">0${n}.</span><h3>${title}</h3><div class="seg" role="group" aria-label="List on show">${toggle}</div><span class="kc">${total}</span></div>
    <div class="kbody">${body || `<p class="kempty">${empty}</p>`}</div></div>`;
  let brief = false; // names as First L.
  const draw = () => { $('roster').innerHTML = !people.size ? '<p class="empty">Nobody on the list yet. Add players above, or paste this week\'s list.</p>'
    : rosterView === 'here' ? panel(1, 'Here', count('here'), L.here, count('here') ? list('here', L.rows, L.here) : '', 'Nobody here yet.')
      : panel(2, 'To arrive', count('arrive'), L.arrive, (count('arrive') ? list('arrive', L.arrivePer, L.arrive) : '')
        + (count('done') ? list('done', L.rows, L.arrive, 'Done for the night') : ''), 'Everyone is here.'); };
  // A name cut off by its column: a smaller size first (more rows a column, so fewer and wider columns),
  // and only at the smallest does everyone go to First L. (the full name stays in the hover title), at
  // the biggest size that then fits. Read from across the gym, a whole name beats a big initial.
  const cut = () => [...$('roster').querySelectorAll('.rrow b')].some(b => b.scrollWidth > b.clientWidth);
  for (;;) {
    $('roster').style.setProperty('--rs', L.scale);
    draw();
    if (!cut()) break;
    const i = SCALES.indexOf(L.scale);
    if (i >= 0 && i < SCALES.length - 1) L = rosterLayout(counts, SCALES[i + 1]);
    else if (!brief) { brief = true; L = rosterLayout(counts); }
    else break;
  }

  $('choices').innerHTML = needsChoice.map(c => `<div class="notice">
      <b>${esc(c.query)} matches ${c.choices.length} players. Which one is coming?</b>
      <div class="btns">${[...c.choices.map(n => btn('choose', n, esc(n), { arg: esc(c.query) })),
        btn('choose', c.query, 'New player', { arg: esc(c.query) })].join('')}</div>
    </div>`).join('');

  renderDot();
}

// The database dot: online and live (this laptop shares the session), offline, or locked; with the
// changes and games still waiting to reach the server.
function renderDot() {
  const unsaved = state.unsynced.length, waiting = pending.length;
  const offline = db === 'offline';
  const dot = $('dbDot');
  const label = `Database ${db === 'locked' ? 'needs the organizer passcode' : db === 'online' && liveId !== null ? 'online, live' : db}${
    waiting ? ` · ${plural(waiting, 'change')} waiting` : ''}${unsaved ? ` · ${plural(unsaved, 'game')} not saved yet` : ''}`;
  dot.className = `island-db ${{ online: 'on', offline: 'off', locked: 'off' }[db] ?? ''}`;
  dot.setAttribute('aria-label', db === 'locked' ? `${label}. Enter passcode` : offline ? `${label}. Try again` : label);
  dot.title = offline ? `${label}. Changes and games are kept on this laptop until the connection is back. Click to try again.`
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
  $('board').classList.toggle('flip', flipped);
  $('flipBtn').setAttribute('aria-pressed', flipped);
  $('boardHint').textContent = ready() ? '' : 'On the Queue tab, fill the spots and set each player to a team.';
}

function renderClock() {
  const g = state.game, ms = remaining();
  $('clock').textContent = clockText(ms);
  $('clock').classList.toggle('low', ms <= 60000);
  $('startBtn').textContent = g.endsAt ? 'Pause' : 'Start';
  $('startBtn').dataset.arg = g.endsAt ? 'pause' : 'start'; // what a tap means, so a replay can't flip it
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
  if (state.game.endsAt && state.game.endsAt <= Date.now()) {
    buzz();
    act('clockEnd');
  }
  renderClock();
}, 250);

// The dot only acts when there is something to do: ask for the passcode when the database
// refused it, retry when offline. Online it just shows its state (hover for details).
$('dbDot').onclick = () => { if (db === 'locked') askPasscode(); else if (db !== 'online') { db = 'connecting'; renderTonight(); sync(); poll(); } };
// Enter in the passcode box saves; left to the form it would press Cancel, the first button.
$('passText').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('passDlg').close('save'); } });
$('passDlg').addEventListener('close', () => {
  if ($('passDlg').returnValue !== 'save' || !$('passText').value) return;
  if (GUEST) return guestSignIn($('passText').value);
  const passcode = $('passText').value;
  try { localStorage.setItem(PASS_KEY, passcode); } catch {}
  $('passText').value = '';
  db = 'connecting';
  // Also renews this device's sign-in, e.g. after the passcode was changed.
  api('/api/login', { passcode }).catch(() => {}).finally(() => { sync(); saveList(); poll(); });
});

// Sign out: forget the passcode and the offline copy on this device, then back to the home page.
// Tonight's session stays saved in this browser for whoever signs in next.
async function signOut() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch {}
  try { localStorage.removeItem(PASS_KEY); localStorage.removeItem(PROFILES_KEY); } catch {}
  try { await Promise.all((await caches.keys()).map(k => caches.delete(k))); } catch {}
  location.replace('/');
}

// Keeps the page opening with no connection once it has loaded here (sw.js).
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});

// ---- the guest view ----

// Tonight's totals (GET /api/tonight: plain numbers, nothing private) and the all-time profiles.
async function guestRefresh() {
  if (document.hidden || guestLocked) return; // locked: nothing to fetch until the code is in
  try {
    const res = await fetch('/api/tonight', { cache: 'no-store' });
    if (res.status === 401) throw refused();
    if (res.status === 200) {
      const t = await res.json();
      state.players = t.players.map(p => ({ ...p, readyAt: 0 }));
      state.date = t.date;
    } else if (res.status === 204) state.players = [];
    await api('/api/profiles');
  } catch {} // offline: keep what is shown
  if (active === 'leaders') renderLeaders();
}
// Organizers sign in from the guest view: the passcode buys this device's session, and is kept for
// the app's writes, as the old sign-in page did. Wrong or too many tries: say so and ask again.
async function guestSignIn(passcode) {
  $('passText').value = '';
  let msg = 'No connection. Signing in needs the internet.';
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode }) });
    if (res.ok) {
      try { localStorage.setItem(PASS_KEY, passcode); } catch {}
      return location.assign('/app');
    }
    msg = res.status === 401 ? 'Wrong passcode.' : res.status === 429 ? 'Too many tries. Wait a minute, then try again.' : 'Could not sign in. Try again in a moment.';
  } catch {}
  $('passMsg').textContent = msg;
  askPasscode();
}
// No code (or last week's): ask once, and say so on the leaderboard and in History, which also have a way
// back to the prompt. Not while the organizer sign-in is open.
function lockGuest() {
  if (guestLocked) return;
  guestLocked = true;
  if (!$('passDlg').open) openGuestDlg();
  renderLeaders();
  if (active === 'history') renderHistory();
}
function openGuestDlg() {
  if ($('guestDlg').open) return;
  $('guestMsg').textContent = '';
  $('guestText').value = '';
  $('guestDlg').returnValue = '';
  $('guestDlg').showModal();
}
// The code buys a guest cookie for the rest of the week (POST /api/guest).
async function guestEnter(code) {
  let msg = 'No connection. Try again in a moment.';
  try {
    const res = await fetch('/api/guest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    if (res.ok) {
      guestLocked = false;
      await guestRefresh();
      if (active === 'history') renderHistory();
      return;
    }
    msg = res.status === 401 ? "That isn't this week's code." : res.status === 429 ? 'Too many tries. Wait a minute, then try again.' : 'Could not check the code. Try again in a moment.';
  } catch {}
  openGuestDlg();
  $('guestMsg').textContent = msg;
}
$('guestText').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('guestDlg').close('enter'); } });
$('guestDlg').addEventListener('close', () => { if ($('guestDlg').returnValue === 'enter' && $('guestText').value.trim()) guestEnter($('guestText').value); });

function guestStart() {
  $('signinBtn').hidden = false;
  $('dbDot').hidden = true;
  $('passTitle').textContent = 'Organizer sign in';
  $('passNote').textContent = 'For organizers running the night. This laptop or phone stays signed in for 30 days.';
  $('signinBtn').addEventListener('click', () => { $('passMsg').textContent = ''; askPasscode(); });
  // Not signed in (else the server would have sent this device to /app): forget a passcode left from
  // an expired sign-in. Signed in after all (an offline copy opened here): go to the organizer app.
  fetch('/api/session', { cache: 'no-store' }).then(r => {
    if (r.ok) location.replace('/app');
    else if (r.status === 401) { try { localStorage.removeItem(PASS_KEY); } catch {} }
  }).catch(() => {});
  if (new URLSearchParams(location.search).has('signin')) { // sent here from /app: the session ran out
    try { history.replaceState(null, '', '/' + location.hash); } catch {}
    askPasscode();
  }
  guestRefresh(); // a guest without this week's code gets the prompt from the first 401
  setInterval(guestRefresh, GUEST_MS);
  document.addEventListener('visibilitychange', guestRefresh);
}

themeLabel();
route();
render();
if (GUEST) guestStart();
else {
  loadGuestCode();
  sync();
  poll(); // joins the shared session: takes the server's, or shares this laptop's if it is newer
  setInterval(poll, 2000);
  document.addEventListener('visibilitychange', poll);
}
