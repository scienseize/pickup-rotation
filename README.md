# Pick-up rotation

Fair rotation, scoreboard and player stats for the organization's pick-up
basketball sessions. Design and rules: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## On game night (any laptop)

1. Open the app's address (the `*.workers.dev` URL from the last deploy).
2. The first time on a laptop, click the dot next to the black mark in the top
   bar and enter the organizer passcode. Viewing works without it.
3. Green dot: saving to the database. Red dot: no connection or passcode needed.
   Hover over it for details. Finished games are kept and saved later.

A laptop has to open the page online once (a phone hotspot is fine). After
that it opens without a connection too.

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
| Weekly backup of the live database | `npx wrangler d1 export pickup --remote --output backup-YYYY-MM-DD.sql` |
| Change the organizer passcode | `npx wrangler secret put ORGANIZER_PASSCODE` |

Local testing reads the passcode from `.dev.vars` (`ORGANIZER_PASSCODE=...`),
which is not in git. Create the local tables once with
`npx wrangler d1 execute pickup --local --file schema.sql`.
