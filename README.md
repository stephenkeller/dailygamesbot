# Daily Games Discord Bot

A Discord bot that keeps score for daily web puzzle games. People paste a game's normal
share text into the channel; the bot recognises it, records the score, hides the link
preview, reacts ✅ and replies with that puzzle's ranking. Leaderboards show all-time
averages, day-of-week averages and Olympic-style medal tables.

It runs on Cloudflare (a Worker, a Durable Object and a D1 database) at
`dailygames.skeller.dev`. Account-wide Cloudflare setup (domain, Access, deploys) is in
`skeller-dev/CLOUDFLARE.md`; this file covers what is specific to the bot.

> **Status:** the Cloudflare version is built and tested locally but not yet live. Until
> the steps in [Moving from Fly.io](#moving-from-flyio-one-time) are done, the old Python
> bot on Fly.io (the `main` branch before this change) is the one running.

## Supported games

| Game | Usual channel | Score | Better | Notes |
| :--- | :--- | :--- | :--- | :--- |
| Box Office Game | `#box-office-game` | Points, 0–1200 | Higher | Five films at up to 200 points each, plus a bonus of up to 200 that loses 20 per failed guess. The same weekend can come round again months later; see below. |
| Atlantic Daily Crossword | `#crossword` | Time | Lower | Reads "I completed the Crossword in 1 minute and 36 seconds". Leaderboard split by day of the week. |
| Timeline | `#timeline` | Points out of 600 | Higher | |
| Clues By Sam | `#clues-by-sam` | Time plus penalties | Lower | +60 s per mistake (🟨), +90 s per hint (🟡). Leaderboard split by day of the week. |
| Enclose.Horse | `#enclose-horse` | Percentage | Higher | |
| Bracket City | `#bracket-city` | Points | Higher | Regular and Hard Mode are separate games; the channel's default leaderboard is Hard Mode. |

A score is recorded from **any** channel the bot can read. The channel only decides
which game `/leaderboard` means when no game is named, and which channels are checked
for missed messages after an outage.

## Commands

- `/leaderboard [game] [sort_by]`: a game's leaderboard. `game` defaults to the
  channel's game; `sort_by` is `Average Score` (default) or `Medals`.
- `!leaderboard [game] [medals]`: the same as a chat message, e.g.
  `!leaderboard Bracket City medals`, or `!leaderboard medals` in a game channel.
- `/user_scores <user>`: that user's 15 most recent scores, shown only to you.
- `/remove_score <user> <game> <puzzle_id>`: removes a wrong score. Needs
  Administrator, or a role named `mod`. The puzzle id must match what is stored; for
  Box Office Game that is `<weekend>|<date first played>` (e.g.
  `August 8, 2014|2026-08-10`), not just the weekend the bot displays.

## How it works

```text
src/
├── index.ts         Worker entry: slash-command endpoint, status page, cron
├── gateway.ts       Durable Object holding the live connection to Discord
├── messages.ts      What happens to one chat message (record a score, !leaderboard)
├── interactions.ts  Slash commands
├── parsers.ts       One parser per game, and the channel-to-game table
├── leaderboard.ts   Builds the embeds
├── db.ts            All SQL
└── discord.ts       Calls to Discord's REST API
migrations/          D1 schema
scripts/             Command registration, the Fly.io export, a fake Discord for testing
test/                Unit tests (parsers, SQL, leaderboards)
```

**Hearing messages.** Discord only delivers ordinary chat messages over its Gateway, a
WebSocket the bot must keep open. A Worker can't hold one, so a single Durable Object
(`DiscordGateway`) does. It stays connected, sends heartbeats and handles each message
as it arrives. An alarm every 30 seconds reconnects it if the socket is gone, and a
cron trigger every minute starts it if it isn't running at all.

**Surviving restarts.** Deploys and Cloudflare's own updates restart the object, which
drops the connection for a few seconds. On reconnect it resumes its Discord session, so
Discord replays what was sent meanwhile. It also reads each game channel's history from
the last message it handled there and processes anything it hasn't marked ✅. Messages
found this way that are more than ten minutes old are recorded and marked ✅ without a
reply. The first time it sees a channel it walks the whole history, which picks up
scores the old bot missed while it was down.

**Slash commands** don't use the Gateway. Discord POSTs each one to
`/api/interactions`; the Worker checks Discord's signature and answers in the response.
They keep working while the Gateway connection is reconnecting.

**Database.** Two tables in D1, unchanged from the old bot:

| Table | Columns |
| :--- | :--- |
| `users` | `user_id` (Discord id), `username` (last known display name) |
| `scores` | `id`, `user_id`, `game_name`, `puzzle_id`, `score` (used for ranking), `raw_score`, `penalty`, `date` (UTC time posted) |

One score per user, game and puzzle: posting again replaces it. The Durable Object
keeps its own small state (Discord session, channel names, a history cursor per game
channel) in its built-in storage, not in D1.

## Design decisions

- **US Eastern time.** Discord timestamps are UTC, so an 11:30 PM Eastern post is
  already "tomorrow". Message times are converted to `America/New_York` before a parser
  sees them, so undated shares land on the right puzzle and weekday.
- **Parsers return four values:** puzzle id, total score, raw score, penalty. Clues By
  Sam ranks on time plus penalties, and keeping the parts lets the bot show
  `4m 0s (3m 0s + 1m 0s penalty)`. Games without penalties leave the last two empty.
- **One parser per mode.** Bracket City's Regular and Hard modes have different game
  names, so their leaderboards never mix and the schema needs no "mode" column.
- **Day-of-week leaderboards.** Crosswords get harder through the week, so an all-time
  average would punish weekend-only solvers. Games flagged `bucketByDay` (Atlantic
  crossword, Clues By Sam) show a section per weekday and then all days.
- **Medals.** Each puzzle is ranked on its own; ties share a place and the next place
  is skipped (1, 2, 2, 4). Sorting by medals is Olympic order: golds, then silvers,
  then bronzes, then the better average.
- **Box Office repeats.** The game reuses box-office weekends, so the weekend alone
  doesn't identify a puzzle. Scores are grouped as `<weekend>|<date first played>`; a
  post joins the group whose scores are within about a week of it, otherwise it starts
  a new group. Only the weekend is shown to users.
- **Command parity.** Anything `/leaderboard` can do, `!leaderboard` can too.

## Development

```bash
npm install
npm test            # unit tests; the SQL runs against Node's built-in SQLite
npm run typecheck
```

**Never run `wrangler dev` with the real bot token.** It would open a second
connection as the live bot, and both copies would answer every message. To exercise the
whole bot locally, use the stand-in for Discord; the header of
`scripts/fake-discord.mjs` has the three commands. It plays a short script (history
catch-up, live messages, a dropped connection, slash commands) and prints everything
the bot does.

### Adding a game

1. Add a parser to `src/parsers.ts` and to the `parsers` list (order matters: the first
   parser that recognises a message handles it).
2. If the game has its own channel, add it to `CHANNEL_GAME_MAP`.
3. Add a test with a real share message to `test/parsers.test.ts`.

## Operations

- **Deploying:** push to `main`. Workers Builds applies D1 migrations and deploys; never
  run `wrangler deploy` by hand. Each deploy drops the Discord connection for a few
  seconds.
- **Is it up?** Open `https://dailygames.skeller.dev/` (owner sign-in). It shows whether
  the bot is connected, since when, the game channels it is watching, and any fatal
  error (a bad token, or the Message Content intent switched off in the Discord
  developer portal).
- **Logs:** Cloudflare dashboard → Workers & Pages → `dailygames-bot` → Logs.
- **Secrets** (`npx wrangler secret put <NAME>`): `DISCORD_TOKEN` (the bot token) and
  `DISCORD_PUBLIC_KEY` (the application's public key, from the developer portal's
  General Information page).
- **Slash commands changed?** Run `npm run commands:register` with `DISCORD_TOKEN` in
  the environment. Not needed otherwise; Discord keeps the registered commands.
- **Bot permissions in the server:** read messages and history, send messages, add
  reactions, and Manage Messages (to hide link previews; without it everything else
  still works).
- **Cost:** the Durable Object is billed for staying awake around the clock. This is
  expected to fit within the Workers Paid plan's included usage, but it has not been
  confirmed against a real bill; check Billing after the first week.

## Moving from Fly.io (one time)

The old bot is the Fly app `daily-games-bot-steph`, with its database at
`/app/data/scores.db`. The two bots must never run at the same time. Delete this
section once the move is done.

1. Create the tables in D1 (the database `dailygames-db` already exists and is empty):
   `npm run db:migrate:remote`
2. Copy the database off Fly, then stop the old bot straight away:
   ```bash
   ~/.fly/bin/flyctl ssh sftp get /app/data/scores.db data/scores.db -a daily-games-bot-steph
   ~/.fly/bin/flyctl machine list -a daily-games-bot-steph
   ~/.fly/bin/flyctl machine stop <machine_id> -a daily-games-bot-steph
   ```
   If the machine is already stopped, start it first; the copy needs it running.
3. Convert and load the data, and compare the row counts it prints:
   ```bash
   node scripts/export-sqlite.mjs data/scores.db data/import.sql
   npx wrangler d1 execute dailygames-db --remote --file data/import.sql
   npx wrangler d1 execute dailygames-db --remote --command "SELECT COUNT(*) FROM scores"
   ```
4. In the Cloudflare dashboard, create the Worker's build connection to this repo
   (settings in `CLOUDFLARE.md`; deploy command
   `npx wrangler d1 migrations apply dailygames-db --remote && npx wrangler deploy`).
   Merge this branch to `main` and push. The Worker deploys but stays idle: it has no
   token yet.
5. Set the secrets, public key first: `npx wrangler secret put DISCORD_PUBLIC_KEY`,
   then `npx wrangler secret put DISCORD_TOKEN`. Within a minute the bot connects and
   reads through the game channels' history.
6. In the Discord developer portal, set **Interactions Endpoint URL** to
   `https://dailygames.skeller.dev/api/interactions`. Discord tests it when you save.
7. Check `https://dailygames.skeller.dev/`, then post a score and try `/leaderboard`
   and `!leaderboard`.
8. After a week or so without problems, delete the Fly app and its volume, and mark the
   hostname as live in `CLOUDFLARE.md`.

**Going back:** clear the Interactions Endpoint URL, delete the `DISCORD_TOKEN` secret
(`npx wrangler secret delete DISCORD_TOKEN`) so the Worker goes idle, and start the Fly
machine. Scores recorded on Cloudflare in the meantime stay in D1 only.
