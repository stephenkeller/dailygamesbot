import { describe, expect, it } from "vitest";
import { easternDate, parsers } from "../src/parsers";

const TODAY = "2026-11-12";

function parse(text: string) {
  const parser = parsers.find((p) => p.canParse(text));
  return parser ? { game: parser.gameName, ...parser.parse(text, TODAY) } : null;
}

describe("parsers", () => {
  it("Box Office Game: weekend date and trophy score", () => {
    expect(parse("boxofficega.me\nAugust 8, 2014\n🎬🎬🎬🎬🎬\n🏆 800")).toEqual({
      game: "Box Office Game", puzzleId: "August 8, 2014", score: 800, rawScore: null, penalty: null,
    });
  });

  it("Atlantic crossword: seconds only, dated by the message", () => {
    expect(parse("I completed the Crossword in 36 seconds! The Atlantic")).toMatchObject({
      game: "Atlantic Daily Crossword", puzzleId: TODAY, score: 36,
    });
  });

  it("Atlantic crossword: minutes and seconds, with a typed date", () => {
    expect(parse("8/10 I completed the Crossword in 1 minute and 36 seconds! The Atlantic"))
      .toMatchObject({ puzzleId: "2026-08-10", score: 96 });
    expect(parse("I completed the Crossword in 2 minutes and 5 seconds! The Atlantic 08-09-25"))
      .toMatchObject({ puzzleId: "2025-08-09", score: 125 });
  });

  it("Timeline: puzzle number and total", () => {
    expect(parse("Timeline 🗓️ #193\nTotal: 528/600")).toMatchObject({
      game: "Timeline", puzzleId: "193", score: 528,
    });
  });

  it("Clues By Sam: clock time plus penalties", () => {
    expect(parse("I solved the daily #CluesBySam, Aug 10th 2026 (Easy), in 03:01\n🟩🟨🟩\n🟡🟩🟩")).toEqual({
      game: "Clues By Sam", puzzleId: "2026-08-10", score: 181 + 60 + 90, rawScore: 181, penalty: 150,
    });
  });

  it("Clues By Sam: 'less than' time, no penalties", () => {
    expect(parse("#CluesBySam - Jul 24th 2026 (Tricky)\nLess than 23 minutes\n🟩🟩")).toEqual({
      game: "Clues By Sam", puzzleId: "2026-07-24", score: 1380, rawScore: 1380, penalty: 0,
    });
  });

  it("Clues By Sam: handles 1st/2nd/3rd and full month names", () => {
    expect(parse("#CluesBySam - Aug 1st 2026 (Easy)\n01:00")).toMatchObject({ puzzleId: "2026-08-01" });
    expect(parse("#CluesBySam - August 22nd 2026 (Easy)\n01:00")).toMatchObject({ puzzleId: "2026-08-22" });
  });

  it("Enclose.Horse: day number and percentage", () => {
    expect(parse("https://enclose.horse Day 226\n🐴 97.5%")).toMatchObject({
      game: "Enclose.Horse", puzzleId: "Day 226", score: 97.5,
    });
  });

  it("Bracket City: regular and hard mode are separate games", () => {
    expect(parse("[Bracket City]\nAugust 21, 2026\n\nTotal Score: 63.1")).toMatchObject({
      game: "Bracket City", puzzleId: "2026-08-21", score: 63.1,
    });
    expect(parse("[Bracket City]\nAugust 21, 2026\nHard mode!\nTotal Score: 88.0")).toMatchObject({
      game: "Bracket City (Hard Mode)", puzzleId: "2026-08-21", score: 88,
    });
  });

  it("ignores ordinary chat", () => {
    expect(parse("nice one, I got stuck on the last clue")).toBeNull();
  });

  it("recognised but incomplete shares give no score", () => {
    expect(parse("Timeline 🗓️ #193\nTotal: lots")).toEqual({ game: "Timeline" });
  });
});

describe("easternDate", () => {
  it("keeps a late-evening Eastern post on the same day", () => {
    // 11:30 PM EDT on Aug 10 is already Aug 11 in UTC.
    expect(easternDate(new Date("2026-08-11T03:30:00Z"))).toBe("2026-08-10");
    // 11:30 PM EST on Dec 1.
    expect(easternDate(new Date("2026-12-02T04:30:00Z"))).toBe("2026-12-01");
  });
});
