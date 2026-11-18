# Hexagames

Fair rotation, scoreboard and player stats for the organization's pick-up
basketball sessions. Design and rules: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## On game night (any laptop)

1. Open https://hexagames.iaciso.workers.dev
2. The home page shows the ISO logo. Press *Enter as organizer*: a device
   that is already signed in goes straight to the app (`/app`); otherwise the
   passcode box appears. Signing in opens the app's *Home* tab: one button for
   the next step of the night (it starts as *Check in players*), and *Standby
   on TV* (the logo and "Hexagames", full screen). A
   signed-in device that opens the link goes straight to Home. Each laptop or phone stays signed in for 30
   days. The site is organizers only: without signing in, nothing but the
   home page opens.
3. Green dot: saving to the database. Red dot: no connection or passcode needed.
   Hover over it for details. Finished games are kept and saved later.
4. *Start a new session* (Check in tab) asks for the session's date, suggesting the
   coming Thursday; Home says which session it is.
5. Every laptop signed in sees the same night: check-ins, queue, court and score
   show on the others within a few seconds, and anyone can edit. A laptop that
   loses the connection keeps working and catches up. The *History* tab lists
   past sessions by date with their players and box scores.

A laptop has to sign in online once (a phone hotspot is fine). After that it
opens without a connection too. *Sign out* (Home tab) removes the sign-in
and the offline copy from that device, for a shared laptop.

## For whoever maintains it

Needs Node.js. Install the pinned tooling once:

```bash
npm install
```

| Task | Command |
|------|---------|
| Run the tests | `npm test` |
| Try changes locally (separate local database) | `npm run dev`, then open http://localhost:8787 |
| Put changes online | `npm run deploy` |
| Backups | Automatic: every day the live database is exported and, if it changed, committed to the `backups` branch (`.github/workflows/backup.yml`). Run one now: `gh workflow run backup.yml`. Manual copy: `npx wrangler d1 export pickup --remote --output backup-YYYY-MM-DD.sql` |
| Restore a backup | `git show backups:pickup.sql > restore.sql`, then `npx wrangler d1 execute pickup --remote --file restore.sql` (into an empty database) |
| Update an existing database (after a schema change) | `npx wrangler d1 execute pickup --remote --file migrations/0005_result_kind.sql` (each file in `migrations/` once, in order, before deploying the Worker that needs it; `--local` for local testing). Sharing and History need 0004; fixing games and per-game types need 0005 |
| Change the organizer passcode | `npx wrangler secret put ORGANIZER_PASSCODE` (signs every device out; use a long passcode, it opens the whole site) |

Local testing reads the passcode from `.dev.vars` (`ORGANIZER_PASSCODE=...`),
which is not in git. Create the local tables once with
`npx wrangler d1 execute pickup --local --file schema.sql`.
