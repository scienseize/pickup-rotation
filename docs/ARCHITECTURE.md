# Pick-up Rotation and Scoreboard: Architecture and Design

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

- **One laptop, offline.** Gyms often have weak Wi-Fi. No account and no
  internet needed after the files are copied.
- **Zero install.** Run `python3 server.py` (built into macOS) and open
  http://localhost:8000. That adds the player database (section 12). Opening
  `index.html` by double-clicking still runs the queue and scoreboard, just
  without profiles. No build step and no dependencies.
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
- **Resting or gone:** the *Out / Back* toggle on the waiting list
  (`present = false`) takes a player out of the queue for as long as they like,
  whether they're resting for a few games or gone for the day. They stay on the
  leaderboard. *Back* restores their game count and their place, so stepping
  out does not reset anyone to the front, and it doesn't push them to the back
  either.
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
- **Same name twice:** check-in refuses an exact duplicate name among present
  players, so nobody is in the queue twice by mistake.

## 4. Data model

The entire app state is one JSON object, saved under one `localStorage` key.

```js
state = {
  players: [
    { name, games, readyAt, present, totalPoints }    // name is the key
  ],
  game: {                           // the current or next game; never empty
    number,                         // 1, 2, 3 ... within the session
    onCourt: [ { name, team: 'home' | 'away' | null, points } ],
    satOut: [ names ],              // sat out this game; Fill skips them
    homeName, awayName,             // editable labels, default "Home" / "Away"
    endsAt,                         // timestamp while the clock runs, else null
    remainingMs,                    // used while paused
    started                         // clock has run; locks Fill, Pick, Sit out
  },
  log: [ { gameNumber, name, team, points } ],   // one row per player per finished game
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
- **`log`** keeps the per-game breakdown so the leaderboard can show more than
  totals later, without changing the model.

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

1. **Check in.** Type a name in the check-in box. It autocompletes from the
   saved member list. Enter adds the player with `games = 0`, `readyAt = now`.
2. **Fill.** Fills every open "Up next" spot from the fairness order. On an
   empty court this calls a full game of 10. Allowed only before the clock
   first starts.
3. **Pick.** Hand-picks a specific waiting player into an open spot, for
   friends who want to play together (section 3). Same timing rule as Fill.
4. **Sit out.** For a called player who refuses or isn't there: it frees their
   spot, and they keep their place (section 3). Same timing rule.
5. **Assign teams.** The players choose their own sides. The attendant taps
   each called player to set Home or Away. The scoreboard is enabled once all
   called players have a team, with at least one per side. That is normally 10;
   it can be fewer early in a session, before 10 people have arrived.
6. **Play.** Start, pause, and reset the clock. Tap a player's +1, +2 or +3
   when they score, or -1 to fix a mistake. A player's points never go below 0.
7. **Time up.** At 0:00 the buzzer sounds and the clock stops. The game does
   *not* end automatically, so the attendant can count a last-second basket or
   let a tie play on.
8. **End game.** Asks for confirmation. Every on-court player gets
   `games + 1` and `readyAt = now`, their game points go into `totalPoints`,
   and a row per player goes into `log`. The court is then empty, ready for
   *Fill*.
9. **Out / Back.** Toggle a player's `present` flag from the waiting list.
10. **New session.** Asks for confirmation and clears players, game, log and
   tonight's list. Games not yet saved to the database are kept until they are.
11. **Tonight's list.** Before people arrive, add the week's players one at a
   time with the autosuggest box, or paste a list in a dialog. A first name is
   enough when only one player in the database has it. If several do, the app
   asks which one is coming. Press *Done* and the builder folds to one line
   ("13 players on tonight's list · Edit list"). The players then appear under
   *Expected tonight* with their record and a Check in button.

## 6. User interface

**Look:** dark mode of the default artifact design system
(`~/.claude/design/artifact-reference.html`): warm neutrals, Source Serif 4 for
headings and big numerals, Hanken Grotesk for body text, IBM Plex Mono for chips,
and the floating island tab bar. The fonts come from Google Fonts when the laptop
is online. Offline, the page falls back to Georgia and the system font, and
everything still works.

One page with two views and a tab switch between them. The layout targets a
laptop screen and still works at phone width.

### Queue view (for the attendant)

- **Check-in box** with autosuggest. Typing a first name, last name or the
  start of either lists matching players with their record. Tonight's list
  ranks first, then whoever has played more. Enter checks in the only match.
  When a first name is shared, nothing happens until a player is picked. A
  name nobody has used shows a *New player* row.
- **Tonight's list builder:** the same autosuggest, removable name chips, a
  *Paste a list* dialog, and a "needs a choice" callout for shared first
  names. It folds away once the list is done.
- **Expected tonight:** the pasted list, minus whoever has checked in, with
  games, points and average from the database.
- **Up next / On court:** 10 spots with a *Fill* button. Each called player's
  row has their name, games played, a Home/Away toggle, and a *Sit out* button.
  Empty spots show as open. Fill, Pick and Sit out are hidden once the clock
  has started.
- **Waiting list,** in exact fairness order, so everyone can see where they
  stand. Each row shows the player's name, games played, live wait time
  ("waiting 34 min"), a *Pick* button (enabled when a spot is open) and an
  *Out / Back* toggle. The rows that Fill would take are marked "next in line".
  A *Passed over* badge appears on anyone with fewer games than a player in
  Up next.
- **Leaderboard** for the session: name, games played, total points, sorted by
  points, plus each player's all-time average from the database.
- **Player database card:** online / offline / unsaved games, and how many
  players and results are on file.

### Scoreboard view (for the court; full screen)

```
┌──────────────────────────────────────────────────────────┐
│     HOME              19:42               AWAY           │
│      24            [Start/Pause]            18           │
│                       [Reset]                            │
├───────────────────────────┬──────────────────────────────┤
│ Alex     6  +1 +2 +3 -1   │ Sam      8  +1 +2 +3 -1      │
│ Jordan   9  +1 +2 +3 -1   │ Riley    4  +1 +2 +3 -1      │
│ ...                       │ ...                          │
└───────────────────────────┴──────────────────────────────┘
```

- Team totals and the clock use the largest type on the page. The size scales
  with the viewport width (`vw`) and uses tabular numerals, so digits don't
  shift as they change.
- Score buttons are large tap targets (at least 48 px) for fast entry with a
  mouse or touchscreen.
- Team names are editable inline. The default is Home / Away.
- In the last minute the clock changes color. At 0:00 the buzzer sounds.
- **Full screen** uses the browser's Fullscreen API. Esc exits.
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
- Check-in, fill, pick, sit out, out/back, team assignment, the leaderboard, saving, and the
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
| Multiple devices or live sync     | The queue needs to run on a phone while a TV shows the score. This needs a small server or a sync service. |
| Stats beyond points (rebounds, assists, fouls) | Someone is actually available to track them during play. |
| Season leaderboards, CSV export   | The organization wants them. The `results` table already has the rows. |
| Over/under for spectators (imaginary money) | The group wants it. Lines come from `results` (a player's average and spread, recent form). It needs a hosted server so phones can join, plus a `bets` ledger table. Nothing in today's schema has to change. |
| Renaming or merging players in the UI | Typos pile up. Until then, fix names in `players.db` by hand. |
| More than one court               | Sessions regularly have 20+ people waiting.              |
| Linked groups that the app calls together | Hand-picking for groups becomes a regular, time-consuming chore. The app would call a group only when it fits, ranked by its member with the most games. |
| Mid-game substitutions            | Injuries or early exits during a game are common enough that a game count should be split. |
| Automatic team balancing          | Players stop choosing their own teams.                  |
| Session (3-hour) clock            | The venue enforces a hard stop that needs a countdown.   |

## 10. Files

```
index.html       markup and styles; open this to run the app
app.js           state, saving, rendering, scoreboard, clock, buzzer
queue.js         fairness rules, no DOM: waitingOrder, nextInLine, fill, pick, sitOut,
                 passedOver, endGame
queue.test.js    run with `node queue.test.js`; checks the fairness rules
names.js         name matching, no DOM: suggest (ranked prefix match), resolve
names.test.js    run with `node names.test.js`; checks the matching rules
server.py        local server and SQLite player database (Python standard library)
test_server.py   run with `python3 test_server.py`; checks the database rules
players.db       created on first run; not in git
docs/ARCHITECTURE.md
```

`queue.js` is a plain script, not an ES module. Browsers block module imports
from a page opened as a file (`file://`), and double-clicking the file has to
work. It ends with a small `module.exports` guard so Node can load it for the
test.

## 11. How it will be verified

- `node queue.test.js` covers these cases: no repeats before everyone plays,
  latecomer first, short-queue fill, sit-out keeps place and counts no game,
  pick takes a specific player and flags passed-over players, end game adds
  points to totals.
- Manual run in a browser. Check in 13 players and run two games, confirming
  the 3 who did not play go first. Add a latecomer and confirm they go first.
  Sit someone out and confirm they lead the next game; hand-pick a player and
  confirm the Passed over badge appears on whoever was skipped.
  Credit points and confirm the team totals match. Refresh mid-game and confirm
  the clock and scores continue. Let the clock reach 0:00 and confirm the
  buzzer sounds.

## 12. Player database

A small SQLite file, `players.db`, that keeps every player and every game
result across weeks. `server.py` serves the app and the database on
`127.0.0.1:8000` only. It uses the Python standard library, so there is nothing
to install.

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
  retried save harmless.

API (JSON):

| Call | Does |
|------|------|
| `GET /api/profiles` | Every player with games, points and average |
| `POST /api/players {names}` | Adds new names from tonight's list |
| `POST /api/results {session, date, game, rows}` | Saves one finished game |

The server validates every input: names are 1 to 60 characters, and points
are whole numbers from 0 to 200. It serves only `index.html`, `app.js`,
`queue.js` and `names.js`, never the database file or its own source.

**When the server isn't running:** the queue and scoreboard work as before.
Finished games wait in `unsynced` in the browser and are sent when the
database is back (on page load and after every End game). The footer and the
database card show how many games are waiting.
