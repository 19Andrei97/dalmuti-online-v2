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
- Run: `npm start` (`node app.js`; honours `PORT`, `DB_PATH`, `SESSION_SECRET`,
  `ALLOWED_ORIGINS`, `AUTH_ENABLED`). Default port 8080.
- Test: `npm test` → `node --test "test/**/*.test.js"`. Node 18–22 required.
  The glob form matters: Node 24 does not accept a bare directory.
- Audit: `npm audit --omit=dev`.

## Architecture

- `app.js` — Express + Passport + Socket.io wiring. Exports `createServer(opts)`
  returning `{ app, httpServer, manager, userStore, close() }`. Tests pass
  `dbPath`, `rng`, `log`, `taxWindowMs`, `revolutionWindowMs`.
- `server/game-engine.js` — pure, transport-free rules: `shuffle`, `deal`,
  `drawForOrder`, `revolutionCandidates`, `computeRoles`, `roleOf`, `computeTaxes`,
  `validateSelection`, `checkValidity`, `checkRule`, `applyPlay`, `reverseOrder`.
- `server/room-manager.js` — `RoomManager(io, opts)`. Owns rooms, dealing,
  revolution/tax phases, play, reconnection, views. Injectable `rng` for tests.
- `server/config.js` — `Player`, `Game`, `game_state` (`WAITING=0, PLAYING=1,
  TAXATION=2`), `SEATS=8`, room factory/helpers.
- `server/security.js` — `escapeHtml`, `sanitizeNickname`, `sanitizeRoomName`,
  `sanitizeChat`, `createRateLimiter`.
- `server/user-store.js` — SQLite (`better-sqlite3`) + bcryptjs user store.
- `server/auth.js` — Passport local strategy + JSON login handler.
- `src/js/main.js` — client controller. Server messages are i18n keys resolved by
  `resolveMessage()`; never `eval` server data.

## Rules model

- Cards are integers `1..12` (rank = count in deck) plus Joker = `13`; 80 cards.
- Dealing: official distribution — higher-ranked players get the extra cards
  (11/11/11/11/12/12/12 for 7 players). No cards discarded.
- Start of each hand: re-seat by previous finishing order (`room.leaderBoard`),
  or a card draw (`drawForOrder`) for the first hand. Game enters `TAXATION`.
- Revolution: a player dealt both Jokers may declare it (Greater Peon ⇒ Greater
  Revolution reverses the whole order); it cancels taxes and starts play.
- Taxes are interactive: peon picks cards to give, dalmuti picks cards to return,
  with a timed auto-fallback (`resolveTaxes`).
- Leader must play when the table is empty (server-enforced; `language.mustPlay`).

## Security invariants (do not regress)

- Per-recipient views only: `roomView(room, sid)` exposes the recipient's own
  `hand`; other players show `handCount` only. Never broadcast a shared room
  object that contains hands.
- Sanitize all nicknames/room names/chat server-side; render with `.text()`.
- Auth: `RoomManager` enforces login for room actions when a user store is present
  (`ensureAuth`). Display name is bound to the account name, so it cannot be
  spoofed. Tests pass `requireAuth: false` only for pure engine unit tests.
- `NODE_ENV=production` requires `SESSION_SECRET` (throws otherwise).
- CDN `<script>`/`<link>` tags carry SRI + `crossorigin="anonymous"`; the CSP in
  `app.js` must list every allowed CDN host. Keep inline scripts out of HTML
  (`script-src-attr 'none'` blocks inline handlers).
- `data/`, `*.db`, `.env` are gitignored (the DB holds password hashes).

## Conventions

- No `set -e` in shell snippets used here; run tests with an explicit timeout.
- Prefer real socket flows in tests (`socket.io-client`) over mocks. Only the
  transport double (`makeFakeIo` in `test/revolution-tax.test.js`) is stubbed, to
  assert on emissions without touching game logic.
