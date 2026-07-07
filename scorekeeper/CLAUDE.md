# Score Keeper — Project Notes

A mobile-first, installable web app (PWA) for tracking players and turn-by-turn
scores across any point-based tabletop/card game. No build step, no backend —
plain HTML/CSS/JS, data lives in the browser's localStorage.

This file exists so a new Claude session (with no memory of the original
conversation) has full context on requirements, decisions already made, and
what's still open. Read this before changing anything.

## Tech stack / files

- `index.html` — shell, links manifest + stylesheet + app.js
- `styles.css` — all styling (dark theme, mobile-first, CSS variables)
- `app.js` — the entire app: storage, state, rendering, event handling. One
  IIFE, no build tooling, no frameworks. Views are rendered by building HTML
  strings and replacing `#app.innerHTML`; a single delegated `click` listener
  on `document` dispatches on `data-action` attributes.
- `manifest.json` / `sw.js` — PWA install + full offline caching (cache-first
  service worker, app shell precached).
- `icons/icon-192.png`, `icons/icon-512.png` — generated app icons.

To use: serve the folder over http(s) or localhost (service workers require
one of those — file:// won't register), open `index.html` on a phone, "Add to
Home Screen." Runs fully offline after that.

There is no bundler, no npm dependency, no test framework wired into the
shipped folder. During development a throwaway jsdom-based smoke-test script
was used to click through the app programmatically and verify state — it's
not included here, but if you want it recreated (to regression-test future
changes) just ask; it's cheap to rebuild against `app.js`'s
`window.__scorekeeper_debug = { data, ui }` hook, which exposes internal state
for exactly that purpose.

## Basic workflow (what the app is for)

1. **Roster (home screen).** A persistent list of players (name, initials,
   color, games played). Add players with the "+" in the header. This list is
   meant to be reused across many separate game sessions/days.
2. **New Game setup.** Tap "New Game," give the session a game name (e.g.
   "Rummy," free text with autocomplete from past names), pick who's playing
   from the roster (tap or drag), set their turn order, and choose whether
   high or low score wins (skipped entirely for a 1-player/solo session).
3. **Active Game.** A round-by-round score grid, one row/column per round,
   one column/row per player. Tap a box, type a number on the docked keypad,
   hit Done — it commits and jumps to the next player's box in that round so
   a whole round can be entered in one pass. Add rounds as the game
   progresses. Toggle horizontal/vertical layout at any time.
4. **End Game.** Ranks players by the chosen win condition (ties share a
   rank), updates each player's per-game-name played/won stats and their
   overall games-played count, then returns to the roster.

Data (players, game names, full game history, any in-progress game) persists
automatically to localStorage after every change — there's no manual save.

## Data model (localStorage key `scorekeeper_data_v1`)

```
{
  version: 1,
  players: [{
    id, name, initials, color, archived (bool),
    gamesPlayed (int, overall total),
    stats: { "<gameName>": { played, won } }   // per game name, e.g. "Rummy"
  }],
  gameNames: ["Rummy", "Solitaire Golf", ...],  // for autocomplete
  gameHistory: [{
    id, gameName, winCondition: "high"|"low"|null, date, orientation,
    players: [{ playerId, turns: [scores...], total }],
    winnerIds: [playerId, ...]   // empty for solo (winCondition null) games
  }],
  activeGame: null | {
    id, gameName, winCondition, orientation, rounds (int),
    players: [{ playerId, turns: [] }]   // turns is sparse: entries can be
                                          // missing (not yet scored) or a
                                          // number (including 0 or negative)
  }
}
```

`turns[i]` being `undefined` means "no score recorded for that round yet" —
this is load-bearing for out-of-order entry (see below). Do not conflate
"unset" with `0`; they're deliberately different states.

## Product decisions already made (don't re-litigate without reason)

These came out of explicit back-and-forth with the user — treat them as
settled unless the user says otherwise:

- **Turn structure:** open-ended, not fixed-round-count. The UI shows a
  running "Round N" counter; rounds are added manually via a "+ Round"
  control, never auto-added.
- **Win condition:** chosen per game session (high or low), not hardcoded.
  A 1-player ("solo") session skips win/loss tracking entirely — no winner is
  computed, no `won` stat is incremented, just a personal score log.
- **Stats granularity:** win/loss and played counts are tracked **per game
  name**, not globally. A player's roster-wide `gamesPlayed` is a separate
  overall counter.
- **Player identity:** initials are free text (not restricted to 2 letters) —
  emoji are explicitly supported (e.g. "JW🐶" vs "JW🐟" to disambiguate two
  players with the same initials). Each player also gets an auto-assigned
  color (rotating palette) so duplicate-initial players are visually
  distinguishable; color is editable.
- **Archiving, not deleting:** removing a player from active use only sets
  `archived: true` (hidden from roster/new-game by default, toggleable via
  the menu). Players are never hard-deleted, so historical game data always
  still resolves to a real player record.
- **Backup:** JSON export/import via the header menu. Import **replaces**
  all local data after a confirm prompt (no merge logic) — this was an
  explicit choice over a more complex merge, since the use case is
  backup/restore or moving to a new phone, not combining two devices' data.
- **Score entry UX (this took a few iterations, current behavior is final):**
  - Tapping a score cell makes it the live-editing cell (highlighted in the
    table) and docks a compact numeric keypad at the bottom of the screen.
    There is **no modal popup** for score entry — earlier versions used one
    and it was explicitly rejected as too many taps.
  - **Pressing "Done"** commits the value (empty box = a deliberate scratch,
    recorded as `0`) and **auto-advances** the active cell to the next
    player's box in the same round. If it's the last player in the round,
    the keypad just closes.
  - **Navigating away any other way** (tapping a different cell, changing
    orientation, adding a round, ending the game, etc.) without pressing
    Done: if nothing was typed, the cell is left **blank/unset** — it is NOT
    scored as 0. This is specifically so scores can be entered out of order
    (skip a player, come back later) without accidentally zeroing them out.
    If something *was* typed, navigating away still commits it (only a
    completely untouched box is left blank).
  - The score table scrolls both directions with sticky headers (round
    labels pinned left, player headers pinned top) so it works with many
    players or many rounds. Scroll position is explicitly preserved across
    re-renders (see `render()` in app.js) — this had to be fixed once
    already because re-rendering on every keystroke was resetting scroll to
    the top.
  - Reordering the active-player lineup during New Game setup supports both
    a drag handle and up/down arrow buttons (arrows as the reliable
    fallback, since drag can be flaky on some phones).

## Explicitly out of scope / not built

- No UI to browse full game history (the data is captured in
  `gameHistory` and included in JSON export, just not surfaced as a
  browsable screen yet).
- No visual theme customization beyond the one dark palette.
- No automated test suite ships with the app (see note above about the
  jsdom harness used during development).
- No merge-on-import — import is destructive/replace-all by design.

## If you're picking this up fresh

Read `app.js` top to bottom once — it's one file, organized into clearly
commented sections (storage, utils, each view's render function, action
handlers, click delegation, drag handling, init). The `window.__scorekeeper_debug`
global (only meaningful when running in a real or jsdom browser context) exposes
live `data` and `ui` state, which is the fastest way to verify behavior while
iterating.
