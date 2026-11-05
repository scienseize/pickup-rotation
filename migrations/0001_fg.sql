-- Field goals on each result row, for FG% (2026-11). Run once on each existing database:
--   npx wrangler d1 execute pickup --remote --file migrations/0001_fg.sql   (the live one)
--   npx wrangler d1 execute pickup --local --file migrations/0001_fg.sql    (local testing)
-- New databases get these columns from schema.sql. Games played before this have 0 of 0, which
-- counts as no attempts, so all-time FG% only covers games from here on.
ALTER TABLE results ADD COLUMN fgm INTEGER NOT NULL DEFAULT 0;
ALTER TABLE results ADD COLUMN fga INTEGER NOT NULL DEFAULT 0;
