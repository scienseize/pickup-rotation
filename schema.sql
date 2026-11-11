-- Player database (Cloudflare D1, SQLite). One row per player per game.
-- Averages are queried, never stored, and the same rows will feed over/under lines later.
CREATE TABLE IF NOT EXISTS players (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  added_on TEXT NOT NULL,
  kind TEXT CHECK (kind IN ('UG', 'SHS', 'Alumni', 'Outsider')) -- player type; NULL until set
);
CREATE TABLE IF NOT EXISTS results (
  session INTEGER NOT NULL,
  played_on TEXT NOT NULL,
  game INTEGER NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE REFERENCES players(name),
  points INTEGER NOT NULL CHECK (points BETWEEN 0 AND 200),
  fgm INTEGER NOT NULL DEFAULT 0, -- field goals made: +2 and +3 on the scoreboard
  fga INTEGER NOT NULL DEFAULT 0, -- field goals attempted: makes plus misses
  won INTEGER CHECK (won IN (0, 1)), -- 1 a win, 0 a loss, NULL a tie (or played before results were kept)
  team INTEGER CHECK (team IN (0, 1)), -- 0 home, 1 away; NULL before teams were kept
  UNIQUE (session, game, name)
);
-- The night every laptop shares (2026-11): one row per session, pushed by the app with a version.
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY, -- the session id already used in results.session
  played_on TEXT NOT NULL, -- YYYY-MM-DD, set when the session starts
  version INTEGER NOT NULL, -- +1 on every accepted push
  state TEXT NOT NULL, -- the shared session as JSON
  updated_at TEXT NOT NULL
);
