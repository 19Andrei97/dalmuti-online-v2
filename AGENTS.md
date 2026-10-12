# AGENTS.md

Repository-specific notes for the online *Great Dalmuti* game (Node + Express +
Socket.io v4). Keep this file current when you learn something durable.

## Deploy on Render (free)

The service is deployed from this GitHub repo via the checked-in Blueprint.

1. Render dashboard → **New +** → **Blueprint** → pick this repo → **Apply**.
   `render.yaml` creates one free `web` service (`npm ci` build, `npm start`,
   health check `/healthz`, auto-deploy on commit).
2. Env vars are set by the Blueprint: `NODE_ENV=production`,
   `AUTH_ENABLED=false`, and a generated `SESSION_SECRET`.
3. No disk and no `DB_PATH`: the free tier filesystem is ephemeral, which is why
   the account system is disabled (see below).

Free-tier caveats: the service **spins down after ~15 min idle** (WebSockets drop,
~1 min cold start on the next request), so a persistent account DB is not viable.
Node is pinned to 22 via `.node-version` (Render's Node 24 default has no prebuilt
`better-sqlite3@11.3.0` binary and would build from source).

## Accounts: deprecated, kept for future re-enable

The account system (Passport + `better-sqlite3`, `server/auth.js`,
`server/user-store.js`, `/login`, `/api/*`) is **disabled by default** and runs
guest-only: no database is created, `requireAuth` is off, and `/api/me` returns
`{ authEnabled: false, username: null }`. Guests pick a nickname (kept in
`localStorage`).

To re-enable: set `AUTH_ENABLED=true` (and provide persistent storage / a mounted
disk plus `DB_PATH`). The auth routes then behave exactly as before — login is
required to create or join a room. `/healthz` is always reachable without auth.

## Commands

- Install: `npm install`
- Build frontend: `npm run build` (Tailwind CSS then esbuild). **Run this after
  editing `src/ts/**` or `src/css/tailwind.css`** — the HTML loads the built
  `src/js/main.js`, `src/js/login.js` and `src/css/app.css`.
- Typecheck: `npm run typecheck` (`tsc --noEmit`). The build does not typecheck,
  so run this before committing.
- Watch CSS: `npm run watch:css` while iterating on styles.
- Run: `npm start` (`node app.js`; honours `PORT`, `DB_PATH`, `SESSION_SECRET`,
  `ALLOWED_ORIGINS`, `AUTH_ENABLED`). Default port 8080.
- Test: `npm test` → `node --test "test/**/*.test.js"`. Node 18–22 required.
  The glob form matters: Node 24 does not accept a bare directory.
- Audit: `npm audit --omit=dev`.

## Frontend build (Tailwind CSS + TypeScript + esbuild)

The client was migrated from hand-written CSS/JS to a small build toolchain:

- `src/ts/*.ts` — TypeScript sources (`main.ts`, `login.ts`, plus `types`,
  `i18n`, `dom`, `selection`, `socket`, `client-rules`). Strict mode is on;
  `tsc --noEmit` must stay clean.
- `src/css/tailwind.css` — the single Tailwind entrypoint. Medieval palette,
  self-hosted fonts and card/role components live in `tailwind.config.js` and
  the `@layer` blocks here.
- Build outputs are committed: `src/css/app.css`, `src/js/main.js`,
  `src/js/login.js`. They are served statically from `src/`, so a fresh clone
  runs with `npm ci` alone. Keep them in sync with the sources.
- **Build order matters**: `build:js` runs before `build:css`. Tailwind's content
  scan includes `src/js/**/*.js`, so class names that exist only in the
  generated JS (e.g. `currentTurn`, `chat-open`, `font-display`) are only
  emitted if the JS is built first.
- Everything is self-hosted (fonts in `src/fonts`, card sprites in `src/icons`,
  the socket.io client from the server), so the CSP in `app.js` allows only
  `'self'` — no CDN origins. Do not reintroduce CDN `<script>`/`<link>` tags.

## Client UX notes

- Card selection (`src/ts/selection.ts`): a plain click/tap toggles a rank,
  selecting as many copies as the table demands (`fieldCount`): with two cards on
  the table one click picks two copies of that rank when you hold them, three
  cards picks three, and while leading it picks every copy. Shift-click or a
  long-press (450 ms) toggles a single copy. Re-renders preserve the current
  selection by card value (see `handKey`/`taxKey` in `main.ts`) so the hand does
  not reset on every server update. `setPlayable` gates picks to the ranks that
  can legally answer the field (`playableRanks` in `client-rules.ts`); `null`
  means "no hint" (leading, or the tax prompt).
- A selected card is marked by a gold ring only (`.cards.selected`). It must not
  lift, animate or change z-index: the hand overlaps its cards, so a raised or
  re-stacked card would cover a neighbour and swallow its click target. Border
  only keeps every card's hit area intact.
- Playability hint: `paintSelection` dims hand cards that cannot take part in a
  legal play (`.cards.unplayable`, 75% opacity). It is a hint only — the cards
  stay selectable so an invalid pick can still be explained by the server.
  `test/client-selection.test.js` cross-checks `playableRanks` against the
  engine's `checkRule` for every field, so the hint can never drift from the rule.
- The pass button only asks for confirmation when a card could still be played:
  `hasLegalPlay(hand, last)` (in `client-rules.ts`, also cross-checked against
  `checkRule`) is false when no set or Joker pair can answer the field, and then
  the pass fires straight away.
- Create room: Enter in the name field submits (the dialog form uses
  `method="dialog"`, so `keydown` calls `preventDefault` to avoid closing before
  the emit). An empty name is allowed and a friendly one is generated
  (`generateRoomName`, e.g. "Golden Gardens") instead of rejecting the player.
- Responsive: cards are sized with the `--card-w`/`--card-h` CSS variables
  (smaller under 640px), seats collapse to a 4-column grid, and the chat/score
  sidebar becomes a slide-up bottom sheet on screens narrower than `lg`.
- Panels toggled with `show()` (`#revolution-panel`, `#tax-panel`) must
  not carry a bare `flex` utility alongside `hidden`: Tailwind emits the utility
  layer after the component layer, so `flex` would always beat `hidden` and the
  panel could never hide. Use the `.panel-flex` component class instead (defined
  in `src/css/tailwind.css`).


## Architecture

- `app.js` — Express + Passport + Socket.io wiring. Exports `createServer(opts)`
  returning `{ app, httpServer, manager, userStore, close() }`. Tests pass
  `dbPath`, `rng`, `log`, `taxWindowMs`, `revolutionWindowMs`.
- `server/game-engine.js` — pure, transport-free rules: `shuffle`, `deal`,
  `drawForOrder`, `revolutionCandidates`, `computeRoles`, `roleOf`, `computeTaxes`,
  `validateSelection`, `checkValidity`, `checkRule`, `applyPlay`, `reverseOrder`.
`Game.nextPlayer(selected_card, playerSid, roomData)` / `nextRound(roomData)` own
turn advance and trick resolution (`roomData` lets the winner's seat be looked up
if they go out).
- `server/bot.js` — pure bot strategies (no room/transport state). `choosePlay`
  and `chooseTax` for three difficulties (`easy` random, `medium` sheds its
  worst legal cards, `hard` wins when it can and otherwise preserves Jokers).
  `enumeratePlays` filters candidates through `engine.checkRule`, so a bot can
  never emit an illegal move.
- `server/room-manager.js` — `RoomManager(io, opts)`. Owns rooms, dealing,
  revolution/tax phases, play, reconnection, views. Injectable `rng` for tests.
- `server/config.js` — `Player`, `Game`, `game_state` (`WAITING=0, PLAYING=1,
  TAXATION=2`), `SEATS=8`, room factory/helpers.
- `server/security.js` — `escapeHtml`, `sanitizeNickname`, `sanitizeRoomName`,
  `sanitizeChat`, `createRateLimiter`.
- `server/user-store.js` — SQLite (`better-sqlite3`) + bcryptjs user store.
- `server/auth.js` — Passport local strategy + JSON login handler.
- `src/ts/main.ts` (built to `src/js/main.js`) — client controller. Server
  messages are i18n keys resolved by `resolveMessage()`; never `eval` server data.

## Rules model

- Cards are integers `1..12` (rank = count in deck) plus Joker = `13`; 80 cards.
- Dealing: official distribution — higher-ranked players get the extra cards
  (11/11/11/11/12/12/12 for 7 players). No cards discarded.
- Start of each hand: re-seat by previous finishing order (`room.leaderBoard`),
  or a card draw (`drawForOrder`) for the first hand. Game enters `TAXATION`.
- Revolution: a player dealt both Jokers may declare it (Greater Peon ⇒ Greater
  Revolution reverses the whole order); it cancels taxes and starts play.
- Taxes are one-sided: the Peon's tribute is automatic (the lowest non-Joker
  cards, never a Joker) and the Peon is merely notified (`tax owed`, then a
  `tax result` confirmation). Only the Dalmuti chooses the cards to return
  (`tax phase`), with a timed auto-fallback (`resolveTaxes`). Never surrender
  the Joker when a non-Joker is available (`peonBestCards` /
  `dalmutiWorstCards`).
- Leader must play when the table is empty (server-enforced; `language.mustPlay`).
- Set sizes: a lead/follow may hold **any number of copies of a single rank**
  (e.g. four Peasants), and the Jokers are wild — each Joker played alongside
  other cards takes on that rank, so `{9:3, 13:1}` is a legal set of four 9s.
  `checkRule` enforces this by counting *distinct ranks*, not cards: at most two
  distinct ranks, and if there are two then one must be the Joker. Jokers alone
  count as a 13 and can never be led or used to beat a field.
- "First-deal revolution" (an official optional variant) is not implemented.
- The trick winner leads the next trick (see *Last play / field rendering*).

## Bots

- Only the room host may add bots, and only while `WAITING` (`addBot`,
  `fillBots`, `removeBot`). `addBot`/`fillBots` take a difficulty; a bot occupies
  a real seat, is always `ready`, and is stored in `room.sockets` keyed by a
  synthetic `bot-<hex>` sid (no live socket).
- Bots are auto-started into a hand via `maybeAutoStart`: the hand begins only
  once at least one human is seated and every seated player (humans + bots) is
  ready. Adding bots alone never starts the game.
- Bots act on a timer (`scheduleBot`, `botDelayMs`, default 700ms): revolution
  (a bot dealt both Jokers always declares), tax (`runBotTax`), and play
  (`scheduleNextBotTurn`/`runBotTurn`). Bot turns reuse `applyPlay`, so the rules
  path is identical to a human's.
- Bots cannot outlive their host: when the last human leaves a room, the whole
  room (bots included) is dropped. `removeFromRoom` hands the host role to
  another human if the host leaves.
- `roomView` exposes `isBot`/`difficulty` per player (bots show `handCount`
  only, like everyone else) plus `host` and `canAddBot` for the host's UI.
- When the human whose turn it is leaves mid-hand, `removeFromRoom` keeps the
  room alive (a human remains) and calls `scheduleNextBotTurn`, so a bot still
  advances the turn instead of the hand stalling.

## Last play / field rendering

- `Game.nextPlayer(selected_card, playerSid, roomData)` records
  `game.last = { num, count, by, handCount }` on a real play; a pass (`{}`) leaves
  it untouched. When a trick completes, `nextRound(roomData)` **keeps the winning
  play in a display-only `game.shown`** and clears the rule state `last` (so the
  next play is treated as a lead). `room-manager` fills `handCount` on both after
  the play so the client can tag a finisher as the winner.
- **The trick winner leads the next trick, not the social leader.** `nextRound`
  sets `cur_order_idx` to the seat of `last.by`; if that player went out during
  the trick, the lead passes clockwise to the next still-seated player
  (`nextPlayableSeatFrom`). An earlier version wrongly always reset to the lowest
  seat, handing the lead back to the Greater Dalmuti.
- `roomView` exposes both `last` (rule state) and `shown` (display state). The
  client renders the field from `roomData.shown`, not `last`: after a trick ends
  `last` is null but `shown` keeps the winning cards on the table until a new lead.
  `renderField` keys the rendered play as
  `${shown.by}:${shown.num}:${shown.count}:${shown.handCount}` and returns early
  when the key is unchanged — an unrelated room refresh must not rebuild the field,
  which would restart the flip animation. `whoPlayed` shows the player from
  `shown.by` (not the current-turn seat), so the label matches the cards on the table.
- Field cards flip via `.flip-inner` (`rotateY(180deg)` when `.active`). Three traps:
  the entrance animation must **not** target `.flip-inner` at all — an opacity
  keyframe (even opacity-only, with `both` fill) on the 3D-transformed element
  forces a grouping context that flattens `transform-style: preserve-3d`, so the
  back stays on top and the rank is never revealed. Animate the faces instead:
  `.flip-inner.card-enter > .flip-face { animation: card-enter … }`. A `transform`
  keyframe is worse still — it overrides `.flip-inner.active`'s rotateY at
  animation-level priority. Also, `.active` must be added after a forced reflow
  (`void field.offsetWidth`), otherwise the browser coalesces insertion + class
  change and the 0.6s transition never runs.
- Tailwind purges classes it cannot see in the source scan. `main.ts` builds
  `role-${role}` and `cards ${cardClass(v)}` at runtime; the `role-*` rules live
  in `tailwind.css` but are only emitted because `tailwind.config.js` safelists
  them. Any new runtime-constructed class must be safelisted (or written as a
  literal somewhere scannable).
- `.card-row` overlaps its children with `margin-left: calc(var(--card-w) * -0.55)`
  and the first child sits flush. A wrapped line's first child still keeps that
  negative margin, so the row needs `padding-inline: calc(var(--card-w) * 0.55)`
  to stop the leading card poking out of the container on narrow screens.
- Private rooms live in `this.rooms.hide` and are never broadcast, so `lobbyView`
  only iterates `this.rooms.open`. The client's `appendGameRoom` renders each open
  room as a clickable row that emits `join game room`.

## Security invariants (do not regress)

- Per-recipient views only: `roomView(room, sid)` exposes the recipient's own
  `hand`; other players show `handCount` only. Never broadcast a shared room
  object that contains hands.
- Sanitize all nicknames/room names/chat server-side; render with `.text()`.
- Auth: `RoomManager` enforces login for room actions when a user store is present
  (`ensureAuth`). Display name is bound to the account name, so it cannot be
  spoofed. Tests pass `requireAuth: false` only for pure engine unit tests.
- `NODE_ENV=production` requires `SESSION_SECRET` (throws otherwise).
- No third-party origins: fonts, sprites and the socket.io client are all served
  from `src/`, so the CSP in `app.js` lists only `'self'` (+ `ws:`/`wss:`). Keep
  inline scripts out of HTML (`script-src-attr 'none'` blocks inline handlers).
- `data/`, `*.db`, `.env` are gitignored (the DB holds password hashes).

## Conventions

- No `set -e` in shell snippets used here; run tests with an explicit timeout.
- Prefer real socket flows in tests (`socket.io-client`) over mocks. Only the
  transport double (`makeFakeIo` in `test/revolution-tax.test.js`) is stubbed, to
  assert on emissions without touching game logic.
