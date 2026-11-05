# Hexagames: Architecture and Design

Status: draft for review. No code is written until this document is approved.
Scope: basketball now. Volleyball is designed for (section 8) but not built.

---

## 1. Problem and goals

The organization hosts 3-hour pick-up sessions. Each game lasts 20 minutes, so a
session runs about 9 games on one court. Members arrive at different times, and
there is no fair, visible way to decide who plays next.

Goals:

1. **Fair rotation.** Nobody plays a second game while someone who is present
   has not played their first. The same rule holds for the third game, fourth,
   and so on.
2. **Late arrivals.** People are added only when they show up. A latecomer
   jumps ahead of everyone who has already played.
3. **Scoreboard.** Two team scores and a 20:00 countdown in very large digits,
   readable from the court, with a buzzer at 0:00.
4. **Per-player scoring.** The attendant credits each basket (+1, +2, +3) to
   the player who scored it. Team scores are the sum of their players' points.
5. **Low-stress operation.** One person runs everything from one laptop.
   Nothing is lost if the page is refreshed or the laptop sleeps.

## 2. Constraints

- **Any laptop, offline-safe.** The app is hosted (section 13). Any laptop or
  phone with a browser opens it, with nothing to install or copy. Gym Wi-Fi is
  weak, so everything keeps working without a connection: finished games wait
  in the browser and save when the connection is back, and once a laptop has
  loaded the page it opens again offline.
- **No build step.** Plain HTML, CSS and JavaScript in `public/`. The only
  tooling is Cloudflare's `wrangler`, used to run it locally and deploy.
- **One court.** One game at a time.
- **Survives refresh.** All state is saved to the browser's `localStorage`
  after every change and reloaded on open.
- **Optional TV.** Mirroring the laptop to a TV or projector works with no
  extra support from the app. The scoreboard has a full-screen button.

## 3. Fairness rule (the core of the app)

Each checked-in player carries two numbers:

| Field     | Meaning                                                           |
|-----------|-------------------------------------------------------------------|
| `games`   | How many games this player has finished this session.            |
| `readyAt` | When they became available: check-in time, or when their last game ended. |

**Calling the next game:** from all players who are present and not on court,
sort by `games` ascending, then `readyAt` ascending, then check-in order (a tie
breaker, since all 10 players in a game finish at the same moment), and take
the first 10.

That one sort covers every case:

- **No repeats before everyone plays.** Anyone with 0 games sorts ahead of
  anyone with 1, and so on.
- **Late arrivals.** A latecomer has `games = 0` and goes straight to the
  front, ahead of everyone who has already played.
- **Fair order within a tier.** Among players with the same game count, the
  one who has waited longest goes first.
- **Short queue.** If fewer than 10 players have the lowest game count, the
  open spots fill from the next tier (fewest games, longest wait). There is no
  special case in the code.

Worked example (13 present, A to M checked in in that order):

```
Game 1: A B C D E F G H I J        waiting: K L M (0 games)
Game 2: K L M A B C D E F G        (fillers have 1 game each; check-in order breaks the tie)
N arrives during game 2            N has 0 games
Game 3: N H I J K L M A B C        (N: 0 games; H I J, then K L M: 1 game, H I J waited longer;
                                    A B C fill from the 2-game tier)
```

Edge rules:

- **Called player refuses or is not around** (doesn't want this game, in the
  bathroom, getting water): the attendant presses *Sit out*. That player leaves
  "Up next" without a game counted and keeps their place (same `games`, same
  `readyAt`), so they are first in line next game. Passing costs nobody a
  game, because the next person takes the spot. The open spot is filled by
  *Fill* (next in line) or by a hand-pick (below).
- **Short break:** use *Sit out* when a player is called. They keep their
  place and lead the next game.
- **Done for the night:** the *Done* button on the waiting list
  (`present = false`, after a confirm) takes a player out of the queue for the
  rest of the session. Fill never calls them again. They stay on the
  leaderboard. Players don't leave and come back, so there is no "back"
  button; *Undo* in the "Done for the night" list only fixes a mistaken tap.
- **Players who want to play together (hand-pick):** the app does not try to
  keep groups together. The attendant can *Pick* any waiting player into an
  open "Up next" spot, so friends can be called together. Because this can skip
  people, the app keeps the cost visible:
  - Every waiting player shows their **games played** and **live wait time**
    ("waiting 34 min", from `readyAt`).
  - A waiting player with **fewer games than someone in "Up next"** gets a
    *Passed over* badge. The attendant can see at a glance when a hand-pick
    is unfair and to whom.
  - The waiting list always stays in fairness order, so it is clear who
    *should* be next, whatever was picked.
- **Same name twice:** check-in matches names without case across tonight's
  players. A player already checked in, or done for the night, is refused, so
  nobody is in the queue twice by mistake.

## 4. Data model

The entire app state is one JSON object, saved under one `localStorage` key.

```js
state = {
  players: [
    { name, games, readyAt, present, totalPoints }    // name is the key; present = false means done for the night
  ],
  game: {                           // the current or next game; never empty
    number,                         // 1, 2, 3 ... within the session
    onCourt: [ { name, team: 'home' | 'away', points, sub? } ], // sub: came on as a substitute
    subbedOut: [ { name, team, points } ], // came off after play started; still count
    plan: [ { name, team } ] | null, // Up next's lineup once the organizer edits it
    satOut: [ names ],              // sat out this game; Fill skips them
    homeName, awayName,             // editable labels, default "Home" / "Away"
    endsAt,                         // timestamp while the clock runs, else null
    remainingMs,                    // used while paused
    started                         // clock has run; locks Fill, Pick, Sit out
  },
  expected: [ names ],              // tonight's list, pasted each week
  unsynced: [ game payloads ],      // finished games the database doesn't have yet
  startedAt                         // session start; also the session id in the database
}
```

The open tab lives in the URL (`#queue`, `#board`), so a refresh returns to it.

Design choices:

- **The name is the key.** Check-in matches names without case, so a returning
  player is the same record, and the same person can't be checked in twice.
- **Team score is derived, never stored.** `home score = sum of points of
  onCourt players with team 'home'`. One source of truth means the big number
  and the player rows can never disagree.
- **`expected` is separate from `players`.** Tonight's list only shows who
  should come and their record. Being on the list does not put anyone in the
  queue. Only check-in does, so arrival order still decides fairness.

## 5. Flows

```
 check in ──> waiting list ──> Fill / Pick ─────> Up next (10)
               ^   ^                                 │  Sit out (not counted,
               │   └──────── keeps place ────────────┤   keeps place)
               │                                     │  Assign Home / Away
               │                                     v
               │                                  Playing: clock + per-player points
               │                                     │
               └─────── End game: games+1, readyAt = now, points added to totals
```

1. **Check in.** Tap *Check in* on the player's row in tonight's list. That
   adds them with `games = 0`, `readyAt = now`. A walk-in is added to the list
   first, then checked in the same way.
2. **Fill.** Fills every open "Up next" spot from the fairness order. On an
   empty court this calls a full game of 10. Allowed only before the clock
   first starts and while nobody has scored.
3. **Pick.** Hand-picks a specific waiting player into an open spot, for
   friends who want to play together (section 3). Same timing rule as Fill.
4. **Sit out.** For a called player who refuses or isn't there: it frees their
   spot, and they keep their place (section 3). Same timing rule. *Remove*
   frees a spot the same way but without the sit-out mark, to undo a call made
   by mistake. Sit out, Remove, Fill and Pick all lock once the clock has
   started or anyone has scored, so a clock reset cannot drop a scorer's
   points.
   **Substitution** still works then: on the queue diagram, drag a waiting
   player onto someone on court (or click one, then the other). There is no
   confirm. The sub takes that seat and team. Once play has started, the
   player coming off moves to `subbedOut` with their points, so the team score
   holds and the game counts for both (`Queue.played`). Before that it is a
   plain swap. A player who comes back on gets their points back, so each
   player is one results row. A sub who comes back off without scoring is
   treated as an undo (a sub made by mistake): they leave no results row.
5. **Assign teams.** Every called player is on a team: Fill and Pick put each
   one on the side with fewer players (Home on a tie). The players choose
   their own sides, and the attendant drags anyone who wants the other team
   across on the queue diagram. The scoreboard is enabled once there is at
   least one player per side. That is normally 10;
   it can be fewer early in a session, before 10 people have arrived.
6. **Play.** Start, pause, and reset the clock. Tap a player's +1, +2 or +3
   when they score, or -1 to fix a mistake. A player's points never go below 0.
7. **Time up.** At 0:00 the buzzer sounds and the clock stops. The game does
   *not* end automatically, so the attendant can count a last-second basket or
   let a tie play on.
8. **End game.** Asks for confirmation. Every on-court player gets
   `games + 1` and `readyAt = now`, their game points go into `totalPoints`,
   and the game is queued in `unsynced` for the database. Up next's lineup
   (below) then takes the court in its teams, so the next game is ready to
   start; *Fill* is only needed if spots are open.
9. **Done for the night.** *Done* on the waiting list clears a player's
   `present` flag for the rest of the session. *Undo* reverses a mistaken tap.
10. **New session.** Asks for confirmation and clears players, game and
   tonight's list. Games not yet saved to the database are kept until they are.
11. **Tonight's list.** Before people arrive, add the week's players one at a
   time with the autosuggest box, or paste a list in a dialog. A first name is
   enough when only one player in the database has it. If several do, the app
   asks which one is coming. Each player then has a row with their record, a
   *Check in* button and a × to take them off the list. Checked-in players
   leave the list and move to the queue.

## 6. User interface

**Look:** dark mode of the default artifact design system
(`~/.claude/design/artifact-reference.html`): warm neutrals, Source Serif 4 for
headings and big numerals, Hanken Grotesk for body text, IBM Plex Mono for chips,
and the floating island tab bar. The fonts come from Google Fonts when the laptop
is online. Offline, the page falls back to Georgia and the system font, and
everything still works.

One page with four tabs in the island: Check in, Queue, Scoreboard and
Leaderboard. Each tab is a whole view, and its name is kept in the
URL (`#checkin`, `#queue`, ...) so a refresh returns to it. A small dot beside
the mark in the island shows the database: green when online, red when
offline. Hovering over it (or a screen reader) gives the state and any games
not saved yet. Clicking it asks for the passcode only when the database
refused it, and retries when offline; when online it does nothing. On a laptop the island folds to a small notch (the mark and
the database dot) and opens when the pointer is over it or it has keyboard
focus. Touch screens keep the full bar. The layout targets a
laptop screen and still works at phone width.

### Home tab (where signing in lands)

- The logo behind the title and one button for the next step:

  | Situation | Button |
  |---|---|
  | Nobody checked in | Check in players |
  | Players here, court not set | Fill the court (Queue) |
  | Court and teams set, not started | Start game N (Scoreboard) |
  | Game started | Back to game N (Scoreboard) |

- **Standby on TV** fills the screen with the logo, "Hexagames", the live
  time (with seconds) and today's date. It only exists in full screen; a click or Esc comes back. The queue diagram and the scoreboard keep their own
  *Full screen* buttons.
- *Sign out* lives here.

### Check in tab (for the attendant)

- **Top of the tab:** the "Tonight's list" heading and *Start a new session*.
- **Tonight's list:** one box with autosuggest adds players. Typing a first
  name, last name or the start of either lists matching players with their
  record, then whoever has played more. Enter adds the only match. A single
  word shared by several players always asks which one, including when
  someone is saved under just that first name. A name nobody has used shows a
  *New player* row. *Paste a list* opens a dialog for the weekly names, and
  shared first names wait in a "Which one is coming?" callout.
- **Tonight, as grouped lists:** everyone on tonight's list plus walk-ins, in
  one group per status, in the Apple grouped-list style: a small header with
  the group's count, then its players as quiet one-line rows in rounded cards,
  with hairline separators. Color appears only in the headers (the Home and
  Away team marks, a green dot for Here). Names sort with numbers in order
  (Test 2 before Test 10).
  1. **Home** and **Away:** who is on court, with games tonight.
  2. **Here:** checked in and waiting. *Done* marks a player done for the
     night, so the queue never calls them again.
  3. **To arrive:** *Check in*, and a × to take them off the list.
  4. **Done for the night:** *Undo* puts them back in line.

  A row shows its details (games tonight) until it is hovered or focused,
  then its button. *Check in*, the main action, always shows, and touch
  screens show every button. Each group fills down to the bottom of the
  screen, then starts another column; short groups stack (Home over Away)
  when they fit, and groups never mix. If the columns don't fit across the
  page they get longer, so the page scrolls down, never sideways. About 40
  players fit on one laptop screen (1280x720 and up). A phone shows each
  group as one full-width list. Hovering over a row shows the full name,
  games tonight and their record from the database.

### Queue tab (for the attendant)

The tab is one diagram, shown on the TV and used by the organizer. Every
queue action happens on it, and none asks to confirm: each has a way back.
On laptop screens and up the diagram spans the page and reaches the bottom of
the screen, and its type and boxes scale with its width (as in full screen),
so it reads from across the gym. Phones keep a stacked layout.

- **Layout:** On court (Home and Away, "Home · 4 of 5"), then Up next, then everyone else waiting, grouped by games played
  tonight, then Done for the night. Each box shows the first name, games
  played and wait time, plus "sitting out" or "passed over" when they apply.
  Before the game fills, Up next is who Fill calls now. Once it's full, Up
  next is the following game's lineup, already split into Home and Away (5
  and 5, with a team-colored edge): the fairness order for that game
  (`Queue.nextGame`, the same rule run on a copy), balanced between the
  teams. Edits to it are kept in `game.plan`; a planned player who leaves is
  replaced by the next in fairness order. End game seats this lineup. *Fill open spots* sits at the top of On court while spots are open;
  *Full screen* sits at the top of Waiting and puts only the diagram on the TV.
- **Click a box** to select it; its buttons appear inside it. On court:
  *Sit out*, *Remove* (no team buttons: teams change by dragging). Waiting: *Pick* (while a spot is open)
  and *Done*. Done for the night: *Undo*. Clicking a second box pairs the
  two: a waiting player and someone on court is a substitution; a waiting
  player and someone in Up next swaps the waiting player into the lineup;
  two players on opposite teams (both on court, or both in Up next) swap
  sides. Clicking
  the box again, clicking empty space or pressing Esc clears the selection.
  Boxes work with the keyboard too (Tab, then Enter).
- **Drag a box:** a waiting player onto Home or Away calls them onto that
  team; onto a player on court subs them in. A player on court onto the other
  team switches sides, and onto a player on the other team swaps the two
  (for when both teams are full); onto Up next or Waiting undoes the call.
  In Up next, a waiting player onto a lineup player replaces them; a lineup
  player onto the other team (or onto someone on it) switches or swaps them.
  The area under the pointer lights up as a drop target.
- Fill, Pick, Sit out and Remove are hidden once the clock has started or
  anyone has scored; dragging between teams and substitutions still work.

### Leaderboard tab

- Tonight's name, games played, total points and points per game, plus each
  player's all-time average from the database. Rows are numbered, and ties
  share a rank.
- **Podium:** ranks 1 to 3 (ties included) are larger, and the leader sits on
  a subtle tile. No team colors here, because players change teams between
  games.
- **One screen for about 30 players:** compact rows, and past 12 players the
  ranking splits into two columns side by side on laptop and TV widths.
  Players who haven't played yet collapse into one "Not played yet" line.
- **Avg** shows the all-time average as a number, or "New". The column is
  hidden when the database isn't loaded.
- A toggle ranks by *Total points* (everyone who has played) or *Per game*.
  Per game only ranks players with at least 2 games (`MIN_RANKED_GAMES`), so
  one lucky game can't top the board. The rest are listed after them with no
  number. The ranking lives in `Queue.leaderboard`.

### Scoreboard view (for the court; full screen)

```
┌──────────────────────────────────────────────────────────┐
│     HOME              19:42               AWAY           │
│      24     [Start] [Reset] [End game] [Full]     18     │
├───────────────────────────┬──────────────────────────────┤
│ Alex     6  +1 +2 +3 -1   │ Sam      8  +1 +2 +3 -1      │
│ Jordan   9  +1 +2 +3 -1   │ Riley    4  +1 +2 +3 -1      │
│ ...                       │ ...                          │
└───────────────────────────┴──────────────────────────────┘
```

- Team totals and the clock use the largest type on the page. The size scales
  with the viewport width (`vw`) and uses tabular numerals, so digits don't
  shift as they change.
- Score buttons are large tap targets for fast entry with a mouse or
  touchscreen. They are 50 px tall, or 38 px on the one-screen laptop layout.
- **One screen.** In a window at least 901 px wide the page does not scroll:
  the player lists keep their height, and the score row takes the rest of the
  window, the same way full screen does. End game, Full screen and the Space
  hint sit in the clock tile. If the window is very short, only the player
  lists scroll. Narrower windows and phones scroll as usual.
- Team names are editable inline. The default is Home / Away.
- **Team colors:** Home is orange and Away is blue, an easy pair for most
  color-blind people too. The colors are two tokens per theme (`--home`,
  `--away`). The score tiles and player cards have a band across the top in
  the team color, with the team name in that color and the score digits
  unchanged. The Queue tab uses the same colors: a colored square before
  each team's label, filled pills on the TV diagram, and a colored left edge
  on the Up next boxes. Anyone without a team gets a dashed pill.
- In the last minute the clock changes color. At 0:00 the buzzer sounds.
- **Full screen** uses the browser's Fullscreen API. Esc exits.
  In full screen the board fills the whole display. The player lists keep
  their natural height, the score row takes the rest, and the scores and clock
  size to their own cards. The small HOME/AWAY chips and the Space hint are
  hidden there. A display shorter than about 850px scrolls the player lists.
- **Keyboard shortcuts** (space = start/pause) for the attendant. Per-player
  scoring stays on buttons, because 10 players times 4 actions is too many
  keys to remember.

## 7. Timer design

- While running, the app stores `endsAt` (a timestamp), not a counter. Every
  tick shows `endsAt - Date.now()`. This keeps the clock from drifting even when
  the browser throttles timers in the background, and the clock keeps the
  right time through a refresh or a laptop sleep.
- Pause saves `remainingMs = endsAt - now`. Resume sets
  `endsAt = now + remainingMs`.
- The display refreshes 4 times a second, so a shown second is never
  more than 250 ms late.
- **Buzzer:** generated with the Web Audio API (a short square-wave tone), so
  no audio file is needed. Browsers allow sound only after a user action. The
  Start button counts as one, so the buzzer is ready by the time it's needed.
- **Game length** is one constant, `GAME_MINUTES = 20`, at the top of the
  script. Change that number if a session ever uses another length.

## 8. Volleyball (future, not built)

What stays the same:

- The fairness rule and queue. They don't depend on the sport. The pick
  function takes `teamSize` as a parameter (basketball 5, volleyball 6), so
  volleyball calls 12 players.
- Check-in, fill, pick, sit out, done for the night, team assignment, the leaderboard, saving, and the
  page layout.

What changes, all of it in the scoreboard:

| Aspect           | Basketball (now)           | Volleyball (future)                          |
|------------------|----------------------------|----------------------------------------------|
| Players on court | 10 (5v5)                   | 12 (6v6)                                     |
| Score buttons    | +1, +2, +3, -1 per player  | +1, -1                                       |
| Team score       | Sum of player points       | Player points **plus** team-only points, since many rallies end on an opponent error that belongs to no player |
| Structure        | One running clock          | Sets: rally scoring to 25, win by 2; a set counter (best of 3 within the 20 minutes) |
| Clock            | 20:00 countdown, required  | Optional: a 20-minute rotation clock; sets may end first |

Implementation path when it's time: add a `sport` field to `state`, choose it
when starting a session, and put the volleyball scoreboard next to the
basketball one. The queue code does not change. A sport plug-in system or
config layer is not planned now. The second sport only needs two branches in
the scoreboard code.

## 9. Non-goals (for now)

| Not included                      | Add it when                                              |
|-----------------------------------|----------------------------------------------------------|
| Accounts, logins                  | Several organizers need separate permissions.           |
| Live sync of tonight's queue      | The queue needs to run on a phone while a TV shows the score, or a laptop dies mid-night. Profiles and results already live on the server; this adds a session snapshot table. |
| Stats beyond points (rebounds, assists, fouls) | Someone is actually available to track them during play. |
| Season leaderboards, CSV export   | The organization wants them. The `results` table already has the rows. |
| Over/under for spectators (imaginary money) | The group wants it. Lines come from `results` (a player's average and spread, recent form). The hosted Worker is already in place; it needs a `bets` ledger table and spectator sign-in. Nothing in today's schema has to change. |
| Renaming or merging players in the UI | Typos pile up. Until then, fix names with `npx wrangler d1 execute pickup --remote --command "UPDATE ..."`. |
| More than one court               | Sessions regularly have 20+ people waiting.              |
| Linked groups that the app calls together | Hand-picking for groups becomes a regular, time-consuming chore. The app would call a group only when it fits, ranked by its member with the most games. |
| Mid-game substitutions            | Injuries or early exits during a game are common enough that a game count should be split. |
| Automatic team balancing          | Players stop choosing their own teams.                  |
| Session (3-hour) clock            | The venue enforces a hard stop that needs a countdown.   |

## 10. Files

```
public/index.html   the home page: logo backdrop, Enter as organizer, the passcode form
public/app.html     the app (served at /app): markup and styles
public/logo.png     the ISO logo from iso.jpg: transparent background, in the app's
                    warm black and white (ink #1c1a19 to paper #faf8f5)
public/favicon.png  the tab icon, the same logo at 64px
public/app.js       state, saving, rendering, scoreboard, clock, buzzer, sync, passcode
public/queue.js     fairness rules, no DOM: waitingOrder, nextInLine, fill, pick, remove,
                    sitOut, passedOver, endGame
public/names.js     name matching, no DOM: suggest (ranked prefix match), resolve
public/sw.js        service worker: opens the page offline once it has loaded
worker/index.js     Cloudflare Worker: the sign-in gate, files and the API on D1
worker/rules.js     API input rules, the passcode check and the session cookie, no I/O
schema.sql          the D1 tables
wrangler.toml       Worker, assets (Worker first), D1 and the sign-in rate limit
package.json        pins wrangler; `npm test`, `npm run dev`, `npm run deploy`
queue.test.js       node queue.test.js
names.test.js       node names.test.js
worker/rules.test.mjs  node worker/rules.test.mjs
worker/index.test.mjs  node worker/index.test.mjs (the sign-in gate end to end)
.dev.vars           local test passcode for `npm run dev`; not in git
README.md           how to run, deploy and back up
docs/ARCHITECTURE.md
```

`queue.js` and `names.js` are plain scripts, not ES modules, and end with a
small `module.exports` guard so Node can load them for the tests.

## 11. How it will be verified

- `node queue.test.js` covers these cases: no repeats before everyone plays,
  latecomer first, short-queue fill, sit-out keeps place and counts no game,
  pick takes a specific player and flags passed-over players, end game adds
  points to totals.
- `node names.test.js` covers the name matching rules.
- `node worker/rules.test.mjs` covers the API rules: names, points, rows,
  dates, the JSON-only check and the passcode compare. `npm test` runs all
  three files.
- `npm run dev` runs the real Worker against a local D1 at
  http://localhost:8787, separate from the live database, for trying changes.
- Manual run in a browser. Check in 13 players and run two games, confirming
  the 3 who did not play go first. Add a latecomer and confirm they go first.
  Sit someone out and confirm they lead the next game; hand-pick a player and
  confirm the Passed over badge appears on whoever was skipped.
  Credit points and confirm the team totals match. Refresh mid-game and confirm
  the clock and scores continue. Let the clock reach 0:00 and confirm the
  buzzer sounds.

## 12. Player database

Every player and every game result across weeks, in Cloudflare D1 (SQLite).
The Worker in `worker/index.js` serves the app's files and this API.

```sql
players (name TEXT PRIMARY KEY COLLATE NOCASE, added_on TEXT)
results (session INTEGER, played_on TEXT, game INTEGER, name TEXT,
         points INTEGER CHECK (points BETWEEN 0 AND 200),
         UNIQUE (session, game, name))
```

- **One row per player per game.** Averages are computed by a query and never
  stored. The same rows will set over/under lines later.
- **Names ignore case,** like check-in. "ana" and "Ana" are the same player,
  and the database's spelling is kept.
- **A game can't be counted twice.** `UNIQUE (session, game, name)` makes a
  retried save harmless, and each game is saved in one transaction.

API (JSON):

Every call except sign-in needs the session cookie (section 13).

| Call | Does | Passcode |
|------|------|----------|
| `POST /api/login {passcode}` | Signs this device in for 30 days (cookie), returns the profiles | The passcode itself |
| `POST /api/logout` | Clears this device's session cookie | No |
| `GET /api/session` | 204 when this device is signed in, else 401 | No (session only) |
| `GET /api/profiles` | Every player with games, points and average | No (session only) |
| `POST /api/players {names}` | Adds new names from tonight's list | Yes |
| `POST /api/results {session, date, game, rows}` | Saves one finished game | Yes |

The Worker validates every input: names are 1 to 60 characters, points are
whole numbers from 0 to 200, rows are a list of objects, and the date is real.
POSTs must be JSON, so other websites can't write. Only the files in `public/`
are served.

**When the connection drops:** the queue and scoreboard work as before.
Finished games wait in `unsynced` in the browser and are sent when the
database is back (on page load and after every End game). The last profiles
list is kept in the browser, so suggestions and averages still show. The
database dot in the island turns red; hovering over it shows how many games are
waiting.

## 13. Hosting, passcode and backups

- **Hosting:** one Cloudflare Worker on the free plan serves `public/` and the
  API, with the database in D1. Nothing sleeps between weekly sessions. The
  code lives in a private GitHub repository.
- **Organizer passcode:** saving players or results needs the passcode, sent as
  `Authorization: Bearer ...` and kept in the browser after it is entered once
  on a laptop. The Worker compares it in constant time with the
  `ORGANIZER_PASSCODE` secret, set with `npx wrangler secret put` and never
  stored in the repository. A missing or wrong passcode gets 401; the app opens
  the passcode dialog and keeps the games until it is right. Entering it there also
  renews the device's sign-in.
- **Organizers only:** the link opens the home page (`/`), with the ISO logo
  as the backdrop and an *Enter as organizer* button that links to the app at
  `/app`. The Worker runs before any file is served (`run_worker_first`) and
  lets through only the home page, the logo, the tab icon and
  `POST /api/login` without a session. Everything else, the app's own files
  and `GET /api/profiles` included, redirects to `/?signin` (pages), which
  opens the passcode form on the home page, or gets 401 (API). A signed-in
  device that opens `/` is redirected straight to `/app`, which opens on the
  Home tab; on the sign-in page the button asks `GET /api/session` (204 signed
  in, 401 not), and any other device gets the passcode box in place, without a
  reload. The old `/login` address redirects home. A right passcode sets a `session` cookie: its expiry plus an
  HMAC-SHA256 of it keyed with `ORGANIZER_PASSCODE`, `HttpOnly; Secure;
  SameSite=Strict`, 30 days. Nothing is stored on the server, and changing the
  passcode signs every device out. Sign-in is limited to 5 tries a minute per
  address (`LOGIN_LIMIT`). *Sign out* on the Home tab clears the cookie,
  the saved passcode and the offline copy on that device.
- **Offline loading:** `public/sw.js` serves the last copy of the page when
  there is no connection. A laptop must sign in online once (a phone hotspot is
  enough) before it can open the app offline. The offline copy never stores the
  sign-in redirect, so an expired session can't overwrite it.
- **Backups:** a GitHub Actions job (`.github/workflows/backup.yml`) exports
  the live database every day and commits it to the `backups` branch of the
  private repo, but only when it changed, so each game night is kept in git
  history. It uses a Cloudflare API token limited to D1 (repo secret
  `CLOUDFLARE_API_TOKEN`) and the account id (repo variable). GitHub emails the
  owner if a run fails. D1 Time Travel also restores to any point in the last
  few days.
- **Still in one browser:** tonight's queue order. If a laptop dies mid-night,
  finished games are safe on the server, but the queue is rebuilt by checking
  people in again.
