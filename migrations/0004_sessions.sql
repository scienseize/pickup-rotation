-- Shared live sessions and session history (2026-11). Run once on each existing database,
-- before deploying the Worker that uses it:
--   npx wrangler d1 execute pickup --remote --file migrations/0004_sessions.sql   (the live one)
--   npx wrangler d1 execute pickup --local --file migrations/0004_sessions.sql    (local testing)
-- sessions holds the night every laptop shares; results.team says which side a player was on.
-- Old results keep team NULL. New databases get both from schema.sql.
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY, -- the session id already used in results.session
  played_on TEXT NOT NULL, -- YYYY-MM-DD, set when the session starts
  version INTEGER NOT NULL, -- +1 on every accepted push
  state TEXT NOT NULL, -- the shared session as JSON
  updated_at TEXT NOT NULL
);
ALTER TABLE results ADD COLUMN team INTEGER CHECK (team IN (0, 1));
