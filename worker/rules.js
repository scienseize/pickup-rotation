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

function isoDate(value) {
  const ok = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value; // rejects 2026-02-31
  if (!ok) throw new Invalid('date must be YYYY-MM-DD');
  return value;
}

// POST /api/players { names }
export function playersBody(body) {
  if (!Array.isArray(body?.names)) throw new Invalid('names must be a list');
  return body.names.map(cleanName);
}

// POST /api/results { session, date, game, rows: [{ name, points }] }
export function gameBody(body) {
  const session = whole(body?.session, 0, 2 ** 53, 'session');
  const game = whole(body.game, 1, 1000, 'game');
  const date = isoDate(body.date);
  if (!Array.isArray(body.rows)) throw new Invalid('rows must be a list');
  const rows = body.rows.map(r => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Invalid('each row must be an object');
    return { name: cleanName(r.name), points: whole(r.points, 0, MAX_POINTS, 'points') };
  });
  return { session, date, game, rows };
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
