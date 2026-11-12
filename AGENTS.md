# Daily Games Discord Bot Guidelines

The bot runs on Cloudflare (Worker, Durable Object, D1). Read `README.md` for how it
works, and `C:\Users\steph\Documents\projects\skeller-dev\CLOUDFLARE.md` for the
account-wide setup before changing anything about hostnames, deploys or resources.

## Rules

1. **Command parity.** Whenever an option is added to or changed in a slash command
   (`src/interactions.ts`, `scripts/register-commands.mjs`), update the matching `!`
   command (`parseLeaderboardCommand` in `src/messages.ts`) so both do the same thing.
   Example: `/leaderboard sort_by: Medals` and `!leaderboard Bracket City medals` (or
   `!leaderboard medals` in the game's channel).

2. **US Eastern time.** Puzzle dates, message dates and day-of-week buckets all use
   `America/New_York`. Convert a message's timestamp with `easternDate()` from
   `src/parsers.ts` before passing it to a parser; never use the UTC date.

3. **Parser interface.** Every parser returns `{ puzzleId, score, rawScore, penalty }`,
   with `rawScore` and `penalty` null when the game has no penalties. A game with
   several difficulty modes gets one parser per mode with distinct `gameName` values, so
   leaderboards stay separate.

4. **Never run `wrangler deploy` by hand, and never run `wrangler dev` with the real
   bot token.** Deploys happen by pushing to `main`. A local copy connected with the
   real token would answer every message alongside the live bot. Test locally with
   `scripts/fake-discord.mjs`.

5. **No secrets in chat or in the repo.** `DISCORD_TOKEN` and `DISCORD_PUBLIC_KEY` are
   set with `npx wrangler secret put`.

6. **Tests.** `npm test` and `npm run typecheck` must pass. A new parser needs a test
   with a real share message.
