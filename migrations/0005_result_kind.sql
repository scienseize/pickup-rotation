-- Each result row keeps the player's type at the time of the game (2026-11), so a player who moves
-- from SHS to UG to Alumni keeps their old games under the old type. Run once on each existing
-- database, before deploying the Worker that uses it:
--   npx wrangler d1 execute pickup --remote --file migrations/0005_result_kind.sql   (the live one)
--   npx wrangler d1 execute pickup --local --file migrations/0005_result_kind.sql    (local testing)
-- Older rows stay NULL and count under the player's current type. New databases get it from schema.sql.
ALTER TABLE results ADD COLUMN kind TEXT CHECK (kind IN ('UG', 'SHS', 'Alumni', 'Outsider'));
