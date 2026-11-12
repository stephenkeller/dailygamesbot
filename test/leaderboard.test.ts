import { beforeEach, describe, expect, it } from "vitest";
import * as database from "../src/db";
import { dailyRankEmbed, formatScore, leaderboardEmbed } from "../src/leaderboard";
import { leaderboardReply, parseLeaderboardCommand } from "../src/messages";
import { findParser } from "../src/parsers";
import { testDatabase } from "./d1";

let db: D1Database;
beforeEach(() => { db = testDatabase(); });

const at = (iso: string) => new Date(iso);

function score(userId: string, gameName: string, puzzleId: string, value: number, postedAt = "2026-08-10T15:00:00Z",
  rawScore: number | null = null, penalty: number | null = null) {
  return database.recordScore(db, {
    userId, username: `user-${userId}`, gameName, puzzleId, score: value, rawScore, penalty, postedAt: at(postedAt),
  });
}

describe("formatScore", () => {
  it("formats times, penalties, percentages and points", () => {
    expect(formatScore(45, null, null, true, "Clues By Sam")).toBe("45s");
    expect(formatScore(240, 180, 60, true, "Clues By Sam")).toBe("4m 0s (3m 0s + 1m 0s penalty)");
    expect(formatScore(100, null, null, false, "Enclose.Horse")).toBe("100%");
    expect(formatScore(63.1, null, null, false, "Bracket City")).toBe("63.10");
    expect(formatScore(528, null, null, false, "Timeline")).toBe("528");
  });
});

describe("scores", () => {
  it("a repost replaces the score; an older message does not", async () => {
    await score("1", "Timeline", "193", 500, "2026-08-10T15:00:00Z");
    await score("1", "Timeline", "193", 550, "2026-08-10T16:00:00Z");
    await score("1", "Timeline", "193", 100, "2026-08-10T09:00:00Z");
    const rows = await database.getPuzzleLeaderboard(db, "Timeline", "193", false);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(550);
  });

  it("daily rank: ties share a place and the poster is bold", async () => {
    await score("1", "Timeline", "193", 550);
    await score("2", "Timeline", "193", 550, "2026-08-10T16:00:00Z");
    await score("3", "Timeline", "193", 400);
    const parser = findParser("Timeline")!;
    const rows = await database.getPuzzleLeaderboard(db, "Timeline", "193", false);
    expect(dailyRankEmbed(parser, "193", rows, "2").description).toBe(
      "🥇 user-1 : 550\n🥇 **user-2** : 550\n🥉 user-3 : 400\n",
    );
  });

  it("medals: ties share a place, and the next place is skipped", async () => {
    await score("1", "Timeline", "1", 600);
    await score("2", "Timeline", "1", 500);
    await score("3", "Timeline", "1", 500);
    await score("4", "Timeline", "1", 400);
    await score("2", "Timeline", "2", 600);
    const medals = await database.getMedalCounts(db, "Timeline", false);
    expect(medals.get("1")!.all).toEqual({ first: 1, second: 0, third: 0 });
    expect(medals.get("2")!.all).toEqual({ first: 1, second: 1, third: 0 });
    expect(medals.get("3")!.all).toEqual({ first: 0, second: 1, third: 0 });
    expect(medals.get("4")!.all).toEqual({ first: 0, second: 0, third: 0 });
  });

  it("leaderboard sorts by average or by medals", async () => {
    // User 1 has the better average; user 2 has more golds.
    await score("1", "Timeline", "1", 600);
    await score("2", "Timeline", "1", 100);
    await score("2", "Timeline", "2", 300);
    await score("2", "Timeline", "3", 300);
    const parser = findParser("Timeline")!;
    const byAverage = await leaderboardEmbed(db, parser, "Average Score");
    expect(byAverage!.fields!.map((f) => f.name)).toEqual([
      "🏆 user-1 • 🥇1 🥈0 🥉0", "#2 user-2 • 🥇2 🥈1 🥉0",
    ]);
    expect(byAverage!.fields![0].value).toBe("Avg: 600.0 (1 plays)");
    const byMedals = await leaderboardEmbed(db, parser, "Medals");
    expect(byMedals!.fields![0].name).toBe("🏆 user-2 • 🥇2 🥈1 🥉0");
  });

  it("bucketed leaderboard: one section per weekday, then all days", async () => {
    // 2026-08-10 is a Monday, 2026-08-16 a Sunday. Lower time is better.
    await score("1", "Clues By Sam", "2026-08-10", 240, undefined, 180, 60);
    await score("2", "Clues By Sam", "2026-08-10", 300, undefined, 300, 0);
    await score("1", "Clues By Sam", "2026-08-16", 50, undefined, 50, 0);
    const embed = await leaderboardEmbed(db, findParser("Clues By Sam")!, "Average Score");
    expect(embed!.fields!.map((f) => f.name)).toEqual(["📅 Monday", "📅 Sunday", "🌍 All Days"]);
    expect(embed!.fields![0].value).toBe(
      "🏆 **user-1** • 🥇1 🥈0 🥉0\nAvg: 4m 0s (3m 0s + 1m 0s penalty) (1 plays)\n\n"
      + "#2 **user-2** • 🥇0 🥈1 🥉0\nAvg: 5m 0s (1 plays)\n\n",
    );
    expect(embed!.fields![2].value).toContain("🏆 **user-1** • 🥇2 🥈0 🥉0");
  });

  it("no scores means no leaderboard", async () => {
    expect(await leaderboardEmbed(db, findParser("Timeline")!, "Medals")).toBeNull();
    expect(await leaderboardEmbed(db, findParser("Clues By Sam")!, "Medals")).toBeNull();
  });

  it("remove and recent scores", async () => {
    await score("1", "Timeline", "193", 550, "2026-08-10T15:00:00Z");
    await score("1", "Timeline", "194", 560, "2026-08-11T15:00:00Z");
    expect((await database.getUserScores(db, "1")).map((r) => r.puzzle_id)).toEqual(["194", "193"]);
    expect(await database.deleteScore(db, "1", "Timeline", "193")).toBe(true);
    expect(await database.deleteScore(db, "1", "Timeline", "193")).toBe(false);
  });
});

describe("Box Office repeats", () => {
  const weekend = "August 8, 2014";
  const resolve = (iso: string) =>
    database.resolveBoxOfficePuzzleId(db, weekend, at(iso), iso.slice(0, 10));

  it("groups posts within a week and starts a new group later", async () => {
    expect(await resolve("2026-08-10T15:00:00Z")).toBe(`${weekend}|2026-08-10`);
    await score("1", "Box Office Game", `${weekend}|2026-08-10`, 800, "2026-08-10T15:00:00Z");
    expect(await resolve("2026-08-14T15:00:00Z")).toBe(`${weekend}|2026-08-10`);
    expect(await resolve("2026-10-12T15:00:00Z")).toBe(`${weekend}|2026-10-12`);
  });

  it("an old missed post joins its own group, not the latest repeat", async () => {
    await score("1", "Box Office Game", `${weekend}|2026-08-10`, 800, "2026-08-10T15:00:00Z");
    await score("1", "Box Office Game", `${weekend}|2026-10-12`, 900, "2026-10-12T15:00:00Z");
    expect(await resolve("2026-08-11T15:00:00Z")).toBe(`${weekend}|2026-08-10`);
  });
});

describe("!leaderboard", () => {
  it("parses the game and the medals keyword", () => {
    expect(parseLeaderboardCommand("!leaderboard")).toEqual({ game: null, sortBy: "Average Score" });
    expect(parseLeaderboardCommand("!leaderboard medals")).toEqual({ game: null, sortBy: "Medals" });
    expect(parseLeaderboardCommand("!leaderboard Bracket City medals")).toEqual({ game: "Bracket City", sortBy: "Medals" });
    expect(parseLeaderboardCommand("!leaderboard Timeline - Medals")).toEqual({ game: "Timeline", sortBy: "Medals" });
    expect(parseLeaderboardCommand("!leaderboards")).toBeNull();
    expect(parseLeaderboardCommand("see !leaderboard")).toBeNull();
  });

  it("falls back to the channel's game, and explains itself otherwise", async () => {
    await score("1", "Bracket City (Hard Mode)", "2026-08-21", 88);
    expect((await leaderboardReply(db, null, "bracket-city", "Average Score", "x")).embed!.title)
      .toBe("Leaderboard: Bracket City (Hard Mode)");
    expect((await leaderboardReply(db, null, "general", "Average Score", "`x`")).content)
      .toBe("Please specify a game! Example: `x`");
    expect((await leaderboardReply(db, "chess", "general", "Average Score", "x")).content)
      .toContain("Game not found. Supported games: Box Office Game");
    expect((await leaderboardReply(db, "timeline", "general", "Average Score", "x")).content)
      .toBe("No scores recorded for Timeline yet.");
  });
});
