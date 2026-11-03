# Database backups

Written by .github/workflows/backup.yml on main. pickup.sql is the latest
export of the live D1 database; every earlier version is in this branch history
(git log -- pickup.sql).

Restore into D1 with:

    npx wrangler d1 execute pickup --remote --file pickup.sql
