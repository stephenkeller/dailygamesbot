# Daily Games Discord Bot Guidelines

## Architecture & Code Conventions

1. **Command Parity**:
   - Whenever a command or option is added or updated in slash commands (`@bot.tree.command`), verify and update the corresponding prefix command (`@bot.command`, e.g., `!leaderboard`) so users have equivalent functionality across both.
   - For example, if `/leaderboard` supports `sort_by: Medals`, `!leaderboard` should support an optional `medals` keyword (e.g. `!leaderboard Bracket City medals` or `!leaderboard medals` inside the bound game channel).

2. **Timezone Handling**:
   - All puzzle date logic, message timestamp conversions, and day-of-week bucket calculations must strictly use US Eastern Time (`America/New_York`).
   - Daily puzzle games turn over on calendar dates in US time zones. Discord message timestamps are in UTC, which can cause late-night submissions to roll over to the following day if not converted.
   - Always convert Discord message timestamps with `message.created_at.astimezone(ZoneInfo("America/New_York"))` before passing to parsers.

3. **Game Parser Interface**:
   - All `GameParser.parse()` implementations must return a 4-tuple: `(puzzle_id, total_score, raw_score, penalty)`. Use `None` for `raw_score` and `penalty` when not applicable.
   - For games with multiple difficulty modes (e.g. Bracket City Hard vs Regular), implement separate parser classes with distinct `game_name` values so leaderboards remain separated.
