// Input rules for the API: what a request may contain and who may write.
// No I/O, so the Worker and its test share them.

export const MAX_NAME = 60;
export const MAX_POINTS = 200;

export class Invalid extends Error {}

export function cleanName(name) {
  if (typeof name !== 'string') throw new Invalid('name must be text');
  const clean = name.trim().split(/\s+/).join(' ');
  if (!clean || clean.length > MAX_NAME) throw new Invalid(`name must be 1 to ${MAX_NAME} characters`);
  return clean;
}

export function whole(value, low, high, what) {
  if (!Number.isInteger(value) || value < low || value > high) {
    throw new Invalid(`${what} must be a whole number from ${low} to ${high}`);
  }
  return value;
}

export function isoDate(value) {
  const ok = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; // rejects 2026-02-31
  if (!ok) throw new Invalid('date must be YYYY-MM-DD');
  return value;
}

// POST /api/players { names }
export function playersBody(body) {
  if (!Array.isArray(body?.names)) throw new Invalid('names must be a list');
  if (body.names.length > 1000) throw new Invalid('too many names (1000 at most)');
  return body.names.map(cleanName);
}

// POST /api/kind { name, kind }: a player's type, or null to clear it.
export const KINDS = ['UG', 'SHS', 'Alumni', 'Outsider'];
export function kindBody(body) {
  const name = cleanName(body?.name), kind = body?.kind ?? null;
  if (kind !== null && !KINDS.includes(kind)) throw new Invalid(`kind must be one of ${KINDS.join(', ')}, or null`);
  return { name, kind };
}

// POST /api/results { session, date, game, rows: [{ name, points, fgm?, fga?, won?, team? }] }
// fgm and fga (field goals made and attempted) are optional, as 0, and won (1 a win, 0 a loss,
// null a tie) is optional, as null, so games saved by an older version of the app still sync.
// team (0 home, 1 away) is optional, as null, and so is kind (the player's type at the time).
// A name may appear once: one row per player per game.
export function gameBody(body) {
  const session = whole(body?.session, 0, 2 ** 53, 'session');
  const game = whole(body.game, 1, 1000, 'game');
  const date = isoDate(body.date);
  if (!Array.isArray(body.rows)) throw new Invalid('rows must be a list');
  if (body.rows.length > 50) throw new Invalid('too many rows (50 at most)');
  const rows = body.rows.map(r => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Invalid('each row must be an object');
    const fga = whole(r.fga ?? 0, 0, MAX_POINTS, 'fga'), fgm = whole(r.fgm ?? 0, 0, fga, 'fgm (no more than fga)');
    const won = r.won ?? null;
    if (won !== null && won !== 0 && won !== 1) throw new Invalid('won must be 1, 0 or null');
    const team = r.team ?? null;
    if (team !== null && team !== 0 && team !== 1) throw new Invalid('team must be 0, 1 or null');
    const kind = r.kind ?? null;
    if (kind !== null && !KINDS.includes(kind)) throw new Invalid(`kind must be one of ${KINDS.join(', ')}, or null`);
    return { name: cleanName(r.name), points: whole(r.points, 0, MAX_POINTS, 'points'), fgm, fga, won, team, kind };
  });
  if (new Set(rows.map(r => r.name.toLowerCase())).size < rows.length) throw new Invalid('a player can be in a game only once');
  return { session, date, game, rows };
}

// POST /api/live { id, date, version, state }: the shared session as one laptop last saw it.
// version is the one the laptop built on (0 for a new session); state is the app's session object.
export function liveBody(body) {
  const id = whole(body?.id, 0, 2 ** 53, 'id');
  const date = isoDate(body.date);
  const version = whole(body.version, 0, 2 ** 31, 'version');
  const state = body.state;
  if (!state || typeof state !== 'object' || !Array.isArray(state.players)) throw new Invalid('state must be an object with a players list');
  return { id, date, version, state };
}

// JSON only: a cross-site form can't send it without a CORS preflight, which we don't answer.
export const isJson = request =>
  (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase() === 'application/json';

// Constant-time passcode check: compare SHA-256 digests byte by byte, never bailing early.
export async function passcodeOk(header, secret) {
  const given = header?.startsWith('Bearer ') ? header.slice(7) : '';
  if (!given || !secret) return false;
  const digest = s => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [a, b] = (await Promise.all([digest(given), digest(secret)])).map(d => new Uint8Array(d));
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Sign-in session: a cookie holding its expiry and an HMAC of it, keyed with SESSION_SECRET plus
// the passcode: a captured cookie can't be used to guess the passcode offline, and changing the
// passcode still signs every device out. Nothing is stored on the server.
export const SESSION_DAYS = 30;
const enc = s => new TextEncoder().encode(s);
const hmacKey = (secret, use) => crypto.subtle.importKey('raw', enc(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [use]);
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

const sessionKey = (passcode, sessionSecret, use) => hmacKey(`${sessionSecret}:${passcode}`, use);

export async function signSession(passcode, now, sessionSecret) {
  if (!passcode || !sessionSecret) throw new Error('SESSION_SECRET and the passcode must be set');
  const exp = String(now + SESSION_DAYS * 864e5);
  return `${exp}.${b64url(await crypto.subtle.sign('HMAC', await sessionKey(passcode, sessionSecret, 'sign'), enc(`session:${exp}`)))}`;
}

// True only for an unexpired cookie signed with these secrets. crypto.subtle.verify is constant-time.
export async function sessionOk(cookieHeader, passcode, now, sessionSecret) {
  if (!passcode || !sessionSecret || !cookieHeader) return false;
  const value = cookieHeader.split(/;\s*/).find(c => c.startsWith('session='))?.slice(8) ?? '';
  const parts = value.split('.');
  const [exp, sig] = parts;
  if (parts.length !== 2 || !/^\d+$/.test(exp) || Number(exp) <= now || !sig) return false;
  let bytes;
  try { bytes = unb64url(sig); } catch { return false; }
  return crypto.subtle.verify('HMAC', await sessionKey(passcode, sessionSecret, 'verify'), bytes, enc(`session:${exp}`));
}

// The guest code: anyone with it reads the leaderboard and history (POST /api/guest). It changes every
// week, at the start of session day (Thursday 00:00 in the club's time zone), so the code shown at a
// session works until the next one. It is worked out from the secrets and the week number, so nothing is
// stored: changing the passcode or SESSION_SECRET also changes it at once (and signs every guest out).
export const TZ_HOURS = 8; // the club's time zone, UTC+8
const DAY = 864e5, TZ = TZ_HOURS * 36e5;
// Day 0 of the epoch was a Thursday, so a week of whole local days from it starts on Thursday.
export const weekOf = now => Math.floor(Math.floor((now + TZ) / DAY) / 7);
export const weekEnds = week => (week + 1) * 7 * DAY - TZ; // the moment the next week's code starts
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L: read aloud or off a screen
export const GUEST_CODE_LENGTH = 6;
export async function guestCode(passcode, sessionSecret, week) {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', await sessionKey(passcode, sessionSecret, 'sign'), enc(`guest-code:${week}`)));
  return Array.from(mac.slice(0, GUEST_CODE_LENGTH), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}
// What a guest typed, as a code: case and spaces don't matter.
export const cleanCode = s => (typeof s === 'string' ? s.toUpperCase().replace(/[^A-Z0-9]/g, '') : '');

// A guest's cookie: the week it is for and an HMAC of it. Good only during that week.
export async function signGuest(passcode, sessionSecret, week) {
  return `${week}.${b64url(await crypto.subtle.sign('HMAC', await sessionKey(passcode, sessionSecret, 'sign'), enc(`guest:${week}`)))}`;
}
export async function guestOk(cookieHeader, passcode, now, sessionSecret) {
  if (!passcode || !sessionSecret || !cookieHeader) return false;
  const value = cookieHeader.split(/;\s*/).find(c => c.startsWith('guest='))?.slice(6) ?? '';
  const parts = value.split('.');
  const [week, sig] = parts;
  if (parts.length !== 2 || !/^\d+$/.test(week) || Number(week) !== weekOf(now) || !sig) return false;
  let bytes;
  try { bytes = unb64url(sig); } catch { return false; }
  return crypto.subtle.verify('HMAC', await sessionKey(passcode, sessionSecret, 'verify'), bytes, enc(`guest:${week}`));
}
