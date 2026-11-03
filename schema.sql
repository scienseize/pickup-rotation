-- Player database (Cloudflare D1, SQLite). One row per player per game.
-- Averages are queried, never stored, and the same rows will feed over/under lines later.
CREATE TABLE IF NOT EXISTS players (
  name TEXT PRIMARY KEY COLLATE NOCASE,
  added_on TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
  session INTEGER NOT NULL,
  played_on TEXT NOT NULL,
  game INTEGER NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE REFERENCES players(name),
  points INTEGER NOT NULL CHECK (points BETWEEN 0 AND 200),
  UNIQUE (session, game, name)
);
