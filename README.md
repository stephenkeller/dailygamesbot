# Daily Games Discord Bot

An automated score-tracking and competitive leaderboard Discord bot tailored for daily web puzzle games. The bot listens in designated channels, automatically detects and parses shared game results, eliminates link preview clutter, records scores to a persistent SQLite database, replies with daily rankings and medals, and provides rich all-time and day-of-week leaderboards.

---

## Table of Contents
- [Overview](#overview)
- [Supported Games](#supported-games)
- [Key Features](#key-features)
- [Design Decisions & Rationale](#design-decisions--rationale)
- [Architecture & Tech Stack](#architecture--tech-stack)
- [Database Schema](#database-schema)
- [Commands Reference](#commands-reference)
- [Deployment & Operations](#deployment--operations)

---

## Overview

Daily puzzle games (like Wordle, Box Office Game, crosswords) have become popular community rituals. However, tracking scores manually across multiple games is tedious, and native game share text varies wildly in format.

This bot provides:
1. **Passive Score Ingestion**: Users simply paste their normal share text into the relevant channel.
2. **Instant Feedback**: The bot suppresses external URL embeds, reacts with a checkmark (`✅`), and replies with the current daily leaderboard (including ties and medals).
3. **Comprehensive Leaderboards**: Supports all-time averages, day-of-week bucketed stats, and Olympic-style medal tables.

---

## Supported Games

| Game | Channel | Scoring Type | Better | Format / Notes |
| :--- | :--- | :--- | :--- | :--- |
| **Box Office Game** | `#box-office-game` | Points | Higher | Points (0–200). Canonicalizes game date & puzzle ID. |
| **The Atlantic Daily Crossword** | `#crossword` | Time | Lower | Time (`MM:SS` or `SSs`). Bucketed Monday–Sunday. |
| **Timeline** | `#timeline` | Points | Higher | Raw points. |
| **Clues By Sam** | `#clues-by-sam` | Time + Penalties | Lower | Time with penalties: +60s per miss (`🟨`), +90s per hint (`🟡`). |
| **Enclose.Horse** | `#enclose-horse` | Percentage | Higher | Accuracy percentage (e.g. `100%`). |
| **Bracket City** | `#bracket-city` | Score | Higher | Points (e.g. `63.1`). Regular Mode & Hard Mode tracked separately. |

---

## Key Features

- **Automated Message Parsing**: Regex-based parsers extract puzzle identifiers and scores directly from clipboard shares.
- **Link Embed Suppression**: Automatically hides bulky link previews from game share URLs to keep chat readable.
- **Daily Medal System**: Awards 🥇 Gold, 🥈 Silver, and 🥉 Bronze for each daily puzzle, properly handling ties.
- **Olympic-Style Medal Sorting**: Option to rank players by total Golds, using Silvers and Bronzes as secondary tie-breakers, and average score as the final tie-breaker.
- **Day-of-Week Bucketing**: For games with variable daily difficulty (e.g., crosswords that grow larger throughout the week), scores are partitioned by day of the week (Monday through Sunday).
- **Dual Command Interface**: Full support for both modern Discord Slash Commands (`/leaderboard`) and quick chat prefix commands (`!leaderboard`).

---

## Design Decisions & Rationale

### 1. US Eastern Timezone Standard (`America/New_York`)
- **Problem**: Discord message timestamps are received in UTC. In UTC, late-night submissions (e.g. 11:30 PM Eastern) occur on the *next calendar day*. For games that don't output an explicit date or for day-of-week bucketing, this caused scores to be misattributed to the wrong puzzle or weekday.
- **Decision**: All Discord message timestamps are converted to `America/New_York` before parsing (`message.created_at.astimezone(ZoneInfo("America/New_York"))`).

### 2. 4-Tuple Parser Signature: `(puzzle_id, total_score, raw_score, penalty)`
- **Problem**: Games like *Clues By Sam* calculate ranking based on completion time plus penalty seconds (60s per miss, 90s per hint). Storing only the final computed score erased the distinction between someone who was fast with errors vs. someone who was slower but clean.
- **Decision**: All parsers adhere to a unified interface returning `(puzzle_id, total_score, raw_score, penalty)`. Games without penalties simply return `None` for the raw score and penalty. The database and leaderboard embeds conditionally format the penalty breakdown:
  ```text
  Avg: 4m 0s (3m 0s + 1m penalty)
  ```

### 3. Separate Parsers for Dual-Mode Games (Bracket City)
- **Problem**: *Bracket City* offers both Regular and Hard modes in the same game family. Merging them into one leaderboard would be unfair, but altering the database schema to introduce a relational "difficulty mode" concept would require disruptive migrations.
- **Decision**: Implemented two separate parser instances—`BracketCityParser` and `BracketCityHardParser`—that share base parsing logic but return distinct `game_name` values (`Bracket City` vs `Bracket City (Hard Mode)`). The channel `#bracket-city` defaults to Hard Mode, keeping leaderboards completely isolated and cleanly partitioned without schema changes.

### 4. In-Memory Olympic Medal Sorting
- **Problem**: When sorting by medals, calculating rankings across all historical puzzles, accounting for multi-user ties per day, and sorting by Gold > Silver > Bronze > Avg Score in a single SQL query is prohibitively complex in SQLite.
- **Decision**: SQLite performs the initial aggregation of average scores and games played. The Python layer queries historical daily podium finishers, maps medals to users, and applies a multi-level Python sort key:
  ```python
  (-golds, -silvers, -bronzes, score_sort_direction * avg_score)
  ```
  This is extremely fast and provides tie-breaking precision.

### 5. Day-of-Week Bucketing for Crosswords
- **Problem**: Crossword puzzles naturally scale in grid size and clue difficulty from Monday to Sunday. Ranking players by all-time average time penalizes players who only attempt weekend puzzles.
- **Decision**: The `AtlanticCrosswordParser` flags `bucket_by_day = True`. The bot aggregates stats and medals per day of the week, generating seven distinct sections (Monday through Sunday) in the leaderboard embed.

### 6. Command Parity (Slash Commands & Prefix Commands)
- **Decision**: Every feature added to Discord slash commands is mirrored in text commands:
  - Slash: `/leaderboard game:Bracket City sort_by:Medals`
  - Text: `!leaderboard Bracket City medals` (or just `!leaderboard medals` inside `#bracket-city`).

---

## Architecture & Tech Stack

```text
daily_games_discord_bot/
├── bot.py                  # Main entry point: Discord client, event listeners, commands & embeds
├── database.py             # SQLite data access layer (aiosqlite) and schema migrations
├── parsers/
│   ├── base.py             # Abstract base class: GameParser
│   ├── atlantic.py         # The Atlantic Daily Crossword parser
│   ├── boxoffice.py        # Box Office Game parser
│   ├── bracketcity.py      # Bracket City (Regular & Hard Mode) parsers
│   ├── cluesbysam.py       # Clues By Sam parser (with penalty calculation)
│   ├── enclosehorse.py     # Enclose.Horse parser
│   └── timeline.py         # Timeline parser
├── Dockerfile              # Container definition for Fly.io deployment
└── fly.toml                # Fly.io app configuration and volume mount
```

- **Runtime**: Python 3.10+
- **Discord API**: `discord.py` (v2.x with app commands / slash commands)
- **Database**: SQLite via `aiosqlite` (async I/O)
- **Hosting**: Fly.io (single lightweight shared-cpu VM with persistent volume)

---

## Database Schema

Database resides at `data/scores.db` (mounted to persistent volume `/app/data` in production).

### `users`
| Column | Type | Description |
| :--- | :--- | :--- |
| `user_id` | `TEXT PRIMARY KEY` | Discord user snowflake ID |
| `username` | `TEXT` | Last known display name |

### `scores`
| Column | Type | Description |
| :--- | :--- | :--- |
| `id` | `INTEGER PRIMARY KEY` | Auto-incrementing identifier |
| `user_id` | `TEXT` | Foreign key to `users.user_id` |
| `game_name` | `TEXT` | Name of the game (e.g. `Clues By Sam`) |
| `puzzle_id` | `TEXT` | Standardized puzzle number or date (`YYYY-MM-DD`) |
| `score` | `REAL` | Final score used for rankings and comparisons |
| `raw_score` | `REAL` | Unadjusted base score (e.g. time before penalties) |
| `penalty` | `REAL` | Total penalty added (e.g. penalty seconds) |
| `date` | `TIMESTAMP` | Submission timestamp (UTC) |

*Constraint: `UNIQUE(user_id, game_name, puzzle_id)` prevents duplicate submissions for the same puzzle.*

---

## Commands Reference

### User Commands
- `/leaderboard [game] [sort_by]`
  - Displays the all-time or bucketed leaderboard.
  - `game`: Optional game name (defaults to current channel's game).
  - `sort_by`: Choose between `Average Score` (default) or `Medals` (Olympic style).
- `!leaderboard [game] [medals]`
  - Text prefix equivalent. Use `!leaderboard medals` inside any game channel.
- `/recent_scores [user]`
  - Shows the most recent score posted by a user across all games.

### Moderator Commands
- `/remove_score <user> <game> <puzzle_id>`
  - Removes an erroneous score submission. Requires Administrator permission or the `mod` role.

---

## Deployment & Operations

The bot is hosted on [Fly.io](https://fly.io) under the app `daily-games-bot-steph`.

### Deploying Changes
```bash
git push origin main
~/.fly/bin/flyctl deploy
```

### Checking Status and Logs
```bash
~/.fly/bin/flyctl status -a daily-games-bot-steph
~/.fly/bin/flyctl logs -a daily-games-bot-steph
```

### Known Operational Note: Discord Gateway Reconnects
If Discord experiences temporary gateway disruptions, `discord.py` re-establishes WebSocket connections. If multiple reconnections happen rapidly, Fly.io's safety supervisor may stop the VM after reaching `max restart count of 10`.

To bring the machine back up:
```bash
~/.fly/bin/flyctl machine start <machine_id> -a daily-games-bot-steph
# or
~/.fly/bin/flyctl apps restart daily-games-bot-steph
```
*(See `.agents/skills/fly-deploy-troubleshooting/SKILL.md` for complete runbook).*
