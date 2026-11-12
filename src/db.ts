// All database access (D1). Scores are unique per (user, game, puzzle).

export interface LeaderboardRow {
  user_id: string;
  username: string;
  plays: number;
  avg_score: number;
  avg_raw: number | null;
  avg_penalty: number | null;
}

export interface PuzzleRow {
  user_id: string;
  username: string;
  score: number;
  raw_score: number | null;
  penalty: number | null;
}

export interface UserScoreRow {
  game_name: string;
  puzzle_id: string;
  score: number;
  raw_score: number | null;
  penalty: number | null;
  date: string;
}

export interface Medals {
  first: number;
  second: number;
  third: number;
}

/** Medal counts for one user: overall, and per day of the week (0 = Sunday). */
export interface UserMedals {
  all: Medals;
  byDay: Record<number, Medals>;
}

export const noMedals = (): Medals => ({ first: 0, second: 0, third: 0 });

/** "YYYY-MM-DD HH:MM:SS" in UTC, the format SQLite's CURRENT_TIMESTAMP writes. */
export function sqlTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

const parseSqlTimestamp = (text: string) => Date.parse(text.replace(" ", "T") + "Z");

export interface NewScore {
  userId: string;
  username: string;
  gameName: string;
  puzzleId: string;
  score: number;
  rawScore: number | null;
  penalty: number | null;
  /** When the message was posted. */
  postedAt: Date;
}

/**
 * Saves a score and the user's current display name. Posting the same puzzle again
 * replaces the score, unless the message is older than the one already saved (which
 * happens when catching up on messages missed earlier).
 */
export async function recordScore(db: D1Database, s: NewScore): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT INTO users (user_id, username) VALUES (?, ?)
       ON CONFLICT(user_id) DO UPDATE SET username = excluded.username`,
    ).bind(s.userId, s.username),
    db.prepare(
      `INSERT INTO scores (user_id, game_name, puzzle_id, score, raw_score, penalty, date)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, game_name, puzzle_id) DO UPDATE SET
         score = excluded.score,
         raw_score = excluded.raw_score,
         penalty = excluded.penalty
       WHERE excluded.date >= scores.date`,
    ).bind(s.userId, s.gameName, s.puzzleId, s.score, s.rawScore, s.penalty, sqlTimestamp(s.postedAt)),
  ]);
}

/** All-time averages for a game, best first. */
export async function getLeaderboard(db: D1Database, gameName: string, ascending: boolean): Promise<LeaderboardRow[]> {
  const order = ascending ? "ASC" : "DESC";
  const { results } = await db.prepare(
    `SELECT s.user_id, u.username, COUNT(s.id) AS plays, AVG(s.score) AS avg_score,
            AVG(s.raw_score) AS avg_raw, AVG(s.penalty) AS avg_penalty
     FROM scores s
     JOIN users u ON s.user_id = u.user_id
     WHERE s.game_name = ?
     GROUP BY s.user_id
     ORDER BY avg_score ${order}`,
  ).bind(gameName).all<LeaderboardRow>();
  return results;
}

/** Everyone's score on one puzzle, best first; ties go to whoever posted first. */
export async function getPuzzleLeaderboard(
  db: D1Database, gameName: string, puzzleId: string, ascending: boolean,
): Promise<PuzzleRow[]> {
  const order = ascending ? "ASC" : "DESC";
  const { results } = await db.prepare(
    `SELECT u.username, s.score, s.raw_score, s.penalty, s.user_id
     FROM scores s
     JOIN users u ON s.user_id = u.user_id
     WHERE s.game_name = ? AND s.puzzle_id = ?
     ORDER BY s.score ${order}, s.date ASC`,
  ).bind(gameName, puzzleId).all<PuzzleRow>();
  return results;
}

/**
 * Averages per day of the week (0 = Sunday), best first within each day. Only puzzles
 * whose id is a date count.
 */
export async function getBucketedLeaderboard(
  db: D1Database, gameName: string, ascending: boolean,
): Promise<Record<number, LeaderboardRow[]>> {
  const order = ascending ? "ASC" : "DESC";
  const { results } = await db.prepare(
    `SELECT s.user_id, u.username, COUNT(s.id) AS plays, AVG(s.score) AS avg_score,
            AVG(s.raw_score) AS avg_raw, AVG(s.penalty) AS avg_penalty,
            CAST(strftime('%w', s.puzzle_id) AS INTEGER) AS dow
     FROM scores s
     JOIN users u ON s.user_id = u.user_id
     WHERE s.game_name = ? AND strftime('%w', s.puzzle_id) IS NOT NULL
     GROUP BY s.user_id, dow
     ORDER BY dow ASC, avg_score ${order}`,
  ).bind(gameName).all<LeaderboardRow & { dow: number }>();
  const days: Record<number, LeaderboardRow[]> = {};
  for (const row of results) (days[row.dow] ??= []).push(row);
  return days;
}

/**
 * Gold, silver and bronze counts per user. Each puzzle is ranked on its own and ties
 * share a place (1, 2, 2, 4), so two people can both take silver.
 */
export async function getMedalCounts(
  db: D1Database, gameName: string, ascending: boolean,
): Promise<Map<string, UserMedals>> {
  const order = ascending ? "ASC" : "DESC";
  const { results } = await db.prepare(
    `SELECT user_id, dow,
            SUM(place = 1) AS first, SUM(place = 2) AS second, SUM(place = 3) AS third
     FROM (
       SELECT s.user_id,
              CAST(strftime('%w', s.puzzle_id) AS INTEGER) AS dow,
              RANK() OVER (PARTITION BY s.puzzle_id ORDER BY s.score ${order}) AS place
       FROM scores s
       JOIN users u ON s.user_id = u.user_id
       WHERE s.game_name = ?
     )
     GROUP BY user_id, dow`,
  ).bind(gameName).all<{ user_id: string; dow: number | null } & Medals>();

  const medals = new Map<string, UserMedals>();
  for (const row of results) {
    let user = medals.get(row.user_id);
    if (!user) medals.set(row.user_id, (user = { all: noMedals(), byDay: {} }));
    user.all.first += row.first;
    user.all.second += row.second;
    user.all.third += row.third;
    if (row.dow !== null) user.byDay[row.dow] = { first: row.first, second: row.second, third: row.third };
  }
  return medals;
}

/** Removes one score; true if there was one to remove. */
export async function deleteScore(db: D1Database, userId: string, gameName: string, puzzleId: string): Promise<boolean> {
  const result = await db.prepare(
    "DELETE FROM scores WHERE user_id = ? AND game_name = ? AND puzzle_id = ?",
  ).bind(userId, gameName, puzzleId).run();
  return result.meta.changes > 0;
}

/** A user's most recent scores across all games. */
export async function getUserScores(db: D1Database, userId: string, limit = 15): Promise<UserScoreRow[]> {
  const { results } = await db.prepare(
    `SELECT game_name, puzzle_id, score, raw_score, penalty, date
     FROM scores
     WHERE user_id = ?
     ORDER BY date DESC
     LIMIT ?`,
  ).bind(userId, limit).all<UserScoreRow>();
  return results;
}

const REPEAT_WINDOW_MS = 8 * 24 * 60 * 60 * 1000;

/**
 * Box Office Game reuses the same box-office weekend months apart, so the weekend's
 * date alone doesn't identify a puzzle. Scores are grouped as "<weekend>|<date first
 * played>": a post joins the existing group whose scores are within about a week of
 * it, and otherwise starts a new one dated `easternToday`.
 */
export async function resolveBoxOfficePuzzleId(
  db: D1Database, weekend: string, postedAt: Date, easternToday: string,
): Promise<string> {
  const { results } = await db.prepare(
    `SELECT puzzle_id, MIN(date) AS first_played, MAX(date) AS last_played
     FROM scores
     WHERE game_name = 'Box Office Game' AND puzzle_id LIKE ?
     GROUP BY puzzle_id
     ORDER BY last_played DESC`,
  ).bind(`${weekend}|%`).all<{ puzzle_id: string; first_played: string; last_played: string }>();

  const posted = postedAt.getTime();
  for (const group of results) {
    const first = parseSqlTimestamp(group.first_played);
    const last = parseSqlTimestamp(group.last_played);
    if (posted > first - REPEAT_WINDOW_MS && posted < last + REPEAT_WINDOW_MS) return group.puzzle_id;
  }
  return `${weekend}|${easternToday}`;
}
