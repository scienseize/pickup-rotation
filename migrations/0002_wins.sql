-- Wins and losses on each result row (2026-11). Run once on each existing database:
--   npx wrangler d1 execute pickup --remote --file migrations/0002_wins.sql   (the live one)
--   npx wrangler d1 execute pickup --local --file migrations/0002_wins.sql    (local testing)
-- 1 a win, 0 a loss, NULL a tie. Games played before this stay NULL, so all-time records only
-- cover games from here on. New databases get the column from schema.sql.
ALTER TABLE results ADD COLUMN won INTEGER CHECK (won IN (0, 1));
