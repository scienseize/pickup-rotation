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
  UNIQUE (session, game, name)
);
