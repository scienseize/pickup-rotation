-- Player types (2026-11): UG, SHS, Alumni or Outsider, set from the app. Run once on each
-- existing database:
--   npx wrangler d1 execute pickup --remote --file migrations/0003_kind.sql   (the live one)
--   npx wrangler d1 execute pickup --local --file migrations/0003_kind.sql    (local testing)
-- Everyone starts with no type (NULL). New databases get the column from schema.sql.
ALTER TABLE players ADD COLUMN kind TEXT CHECK (kind IN ('UG', 'SHS', 'Alumni', 'Outsider'));
