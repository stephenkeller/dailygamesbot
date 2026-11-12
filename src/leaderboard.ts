// Builds the embeds the bot posts: a puzzle's daily ranking, a game's leaderboard, and
// a user's recent scores.

import * as database from "./db";
import type { LeaderboardRow, Medals, PuzzleRow, UserMedals, UserScoreRow } from "./db";
import { findParser, type GameParser } from "./parsers";

export interface Embed {
  title: string;
  color: number;
  description?: string;
  fields?: { name: string; value: string; inline: boolean }[];
}

export type SortBy = "Average Score" | "Medals";

const GREEN = 0x2ecc71;
const GOLD = 0xf1c40f;
const BLUE = 0x3498db;

// Days as SQLite numbers them (0 = Sunday), listed Monday first for display.
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DISPLAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

// Discord rejects an embed field longer than this.
const FIELD_LIMIT = 1024;

export function formatTime(seconds: number): string {
  if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  return `${seconds.toFixed(0)}s`;
}

/** A score as shown to users: a time (with any penalty broken out), a percentage, or points. */
export function formatScore(
  score: number, rawScore: number | null, penalty: number | null, ascending: boolean, gameName: string,
): string {
  if (ascending) {
    const time = formatTime(score);
    if (penalty && penalty > 0 && rawScore) {
      return `${time} (${formatTime(rawScore)} + ${formatTime(penalty)} penalty)`;
    }
    return time;
  }
  const value = Number.isInteger(score) ? score.toFixed(0) : score.toFixed(2);
  return gameName === "Enclose.Horse" ? `${value}%` : value;
}

/** Box Office puzzle ids carry a "|date first played" suffix that users never see. */
export const displayPuzzleId = (puzzleId: string) => puzzleId.split("|")[0];

/** The ranking for one puzzle, with the poster's own name in bold. Ties share a place. */
export function dailyRankEmbed(parser: GameParser, puzzleId: string, rows: PuzzleRow[], authorId: string): Embed {
  let place = 1;
  let placeScore = rows[0].score;
  let description = "";
  rows.forEach((row, i) => {
    if (row.score !== placeScore) {
      place = i + 1;
      placeScore = row.score;
    }
    const medal = place === 1 ? "🥇" : place === 2 ? "🥈" : place === 3 ? "🥉" : `#${place}`;
    const value = formatScore(row.score, row.raw_score, row.penalty, parser.ascending, parser.gameName);
    const name = row.user_id === authorId ? `**${row.username}**` : row.username;
    description += `${medal} ${name} : ${value}\n`;
  });
  return { title: `Daily Rank: ${parser.gameName} (${displayPuzzleId(puzzleId)})`, color: GREEN, description };
}

const medalText = (m: Medals) => `🥇${m.first} 🥈${m.second} 🥉${m.third}`;

/** Olympic order: most golds, then silvers, then bronzes, then the better average. */
function sortByMedals(rows: LeaderboardRow[], medalsOf: (row: LeaderboardRow) => Medals, ascending: boolean): void {
  rows.sort((a, b) => {
    const ma = medalsOf(a);
    const mb = medalsOf(b);
    return (mb.first - ma.first) || (mb.second - ma.second) || (mb.third - ma.third)
      || (ascending ? a.avg_score - b.avg_score : b.avg_score - a.avg_score);
  });
}

function bucketSection(
  rows: LeaderboardRow[], medalsOf: (row: LeaderboardRow) => Medals, parser: GameParser,
): string {
  let text = "";
  rows.forEach((row, i) => {
    const rank = i === 0 ? "🏆" : `#${i + 1}`;
    const score = formatScore(row.avg_score, row.avg_raw, row.avg_penalty, parser.ascending, parser.gameName);
    text += `${rank} **${row.username}** • ${medalText(medalsOf(row))}\nAvg: ${score} (${row.plays} plays)\n\n`;
  });
  return text.slice(0, FIELD_LIMIT);
}

/** A game's leaderboard, or null when it has no scores yet. */
export async function leaderboardEmbed(db: D1Database, parser: GameParser, sortBy: SortBy): Promise<Embed | null> {
  const [medals, overall] = await Promise.all([
    database.getMedalCounts(db, parser.gameName, parser.ascending),
    database.getLeaderboard(db, parser.gameName, parser.ascending),
  ]);
  const userMedals = (row: LeaderboardRow): UserMedals | undefined => medals.get(row.user_id);
  const allMedals = (row: LeaderboardRow) => userMedals(row)?.all ?? database.noMedals();
  const embed: Embed = { title: `Leaderboard: ${parser.gameName}`, color: GOLD, fields: [] };

  if (parser.bucketByDay) {
    // One section per day of the week, then everyone's all-days average.
    const byDay = await database.getBucketedLeaderboard(db, parser.gameName, parser.ascending);
    for (const dow of DISPLAY_ORDER) {
      const rows = byDay[dow];
      if (!rows?.length) continue;
      const dayMedals = (row: LeaderboardRow) => userMedals(row)?.byDay[dow] ?? database.noMedals();
      if (sortBy === "Medals") sortByMedals(rows, dayMedals, parser.ascending);
      embed.fields!.push({ name: `📅 ${DAY_NAMES[dow]}`, value: bucketSection(rows, dayMedals, parser), inline: false });
    }
    if (!embed.fields!.length) return null;
    if (overall.length) {
      if (sortBy === "Medals") sortByMedals(overall, allMedals, parser.ascending);
      embed.fields!.push({ name: "🌍 All Days", value: bucketSection(overall, allMedals, parser), inline: false });
    }
    return embed;
  }

  if (!overall.length) return null;
  if (sortBy === "Medals") sortByMedals(overall, allMedals, parser.ascending);
  overall.forEach((row, i) => {
    let score = row.avg_score.toFixed(1);
    if (parser.ascending) {
      score = row.avg_score > 60
        ? `${Math.floor(row.avg_score / 60)}m ${Math.floor(row.avg_score % 60)}s`
        : `${row.avg_score.toFixed(0)}s`;
    }
    const rank = i === 0 ? "🏆" : `#${i + 1}`;
    embed.fields!.push({
      name: `${rank} ${row.username} • ${medalText(allMedals(row))}`,
      value: `Avg: ${score} (${row.plays} plays)`,
      inline: false,
    });
  });
  // Discord allows 25 fields per embed.
  embed.fields = embed.fields!.slice(0, 25);
  return embed;
}

export function userScoresEmbed(displayName: string, scores: UserScoreRow[]): Embed {
  return {
    title: `Recent Scores: ${displayName}`,
    color: BLUE,
    fields: scores.map((row) => {
      const ascending = findParser(row.game_name)?.ascending ?? false;
      const score = formatScore(row.score, row.raw_score, row.penalty, ascending, row.game_name);
      return {
        name: row.game_name,
        value: `Puzzle: \`${displayPuzzleId(row.puzzle_id)}\`\nScore: ${score}`,
        inline: false,
      };
    }),
  };
}
