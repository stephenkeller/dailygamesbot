// One parser per game. Each recognises a pasted share message and extracts
// (puzzle id, total score, raw score, penalty). Raw score and penalty are null for
// games without penalties. Games with several modes get one parser per mode, with
// distinct names, so their leaderboards stay separate.

export interface ParseResult {
  puzzleId: string;
  score: number;
  rawScore: number | null;
  penalty: number | null;
}

export interface GameParser {
  gameName: string;
  /** True when a lower score is better (times). */
  ascending: boolean;
  /** True when the leaderboard is split by day of the week. */
  bucketByDay: boolean;
  canParse(text: string): boolean;
  /** `messageDate` is the message's date in US Eastern time, as YYYY-MM-DD. */
  parse(text: string, messageDate: string): ParseResult | null;
}

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** Builds YYYY-MM-DD, or null when the month name or the day is not a real date. */
function isoDate(monthName: string, day: number, year: number, allowAbbreviation: boolean): string | null {
  const name = monthName.toLowerCase();
  let month = MONTHS.indexOf(name);
  if (month < 0 && allowAbbreviation && name.length === 3) {
    month = MONTHS.findIndex((m) => m.startsWith(name));
  }
  if (month < 0) return null;
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
  return `${pad(year, 4)}-${pad(month + 1)}-${pad(day)}`;
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

const boxOffice: GameParser = {
  gameName: "Box Office Game",
  ascending: false,
  bucketByDay: false,
  canParse: (text) => text.includes("boxofficega.me") && text.includes("🏆"),
  parse(text) {
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    let puzzleId: string | null = null;
    let score: number | null = null;
    lines.forEach((line, i) => {
      // The line after "boxofficega.me" is the date of the box-office weekend.
      if (line === "boxofficega.me" && i + 1 < lines.length) puzzleId = lines[i + 1];
      if (line.startsWith("🏆")) {
        const match = /🏆\s*(\d+)/u.exec(line);
        if (match) score = Number(match[1]);
      }
    });
    if (puzzleId && score !== null) return { puzzleId, score, rawScore: null, penalty: null };
    return null;
  },
};

const atlantic: GameParser = {
  gameName: "Atlantic Daily Crossword",
  ascending: true,
  bucketByDay: true,
  canParse: (text) => text.includes("I completed the Crossword in") && text.includes("The Atlantic"),
  parse(text, messageDate) {
    // "I completed the Crossword in 36 seconds!" or "... in 1 minute and 36 seconds!"
    const minutes = Number(/(\d+)\s*minutes?/.exec(text)?.[1] ?? 0);
    const seconds = Number(/(\d+)\s*seconds?/.exec(text)?.[1] ?? 0);
    const total = minutes * 60 + seconds;
    if (total <= 0) return null;

    // A date typed by hand (8/10, 08-10, 8/10/26, 8/10/2026) overrides the message date.
    const typed = /\b(1[0-2]|0?[1-9])[-/](3[01]|[12][0-9]|0?[1-9])(?:[-/](\d{4}|\d{2}))?\b/.exec(text);
    let puzzleId = messageDate;
    if (typed) {
      const month = Number(typed[1]);
      const day = Number(typed[2]);
      const yearText = typed[3];
      const year = !yearText
        ? Number(messageDate.slice(0, 4))
        : yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
      puzzleId = `${pad(year, 4)}-${pad(month)}-${pad(day)}`;
    }
    return { puzzleId, score: total, rawScore: null, penalty: null };
  },
};

const timeline: GameParser = {
  gameName: "Timeline",
  ascending: false,
  bucketByDay: false,
  canParse: (text) => text.includes("Timeline 🗓️ #") && text.includes("Total:"),
  parse(text) {
    // Timeline 🗓️ #193
    // Total: 528/600
    const puzzle = /Timeline 🗓️ #(\d+)/u.exec(text);
    const score = /Total:\s*(\d+)\/600/.exec(text);
    if (!puzzle || !score) return null;
    return { puzzleId: puzzle[1], score: Number(score[1]), rawScore: null, penalty: null };
  },
};

const cluesBySam: GameParser = {
  gameName: "Clues By Sam",
  ascending: true,
  bucketByDay: true,
  canParse: (text) => text.includes("#CluesBySam"),
  parse(text, messageDate) {
    // Format 1: "#CluesBySam - Jul 24th 2026 (Tricky)\nLess than 23 minutes"
    // Format 2: "I solved the daily #CluesBySam, Aug 10th 2026 (Easy), in 03:01"
    let puzzleId = messageDate;
    const dateMatch = /#CluesBySam\s*[,\-]\s*(.*?)\s*\(/.exec(text);
    if (dateMatch) {
      const rawDate = dateMatch[1].trim();
      const parts = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s+(\d{4})$/.exec(rawDate);
      puzzleId = (parts && isoDate(parts[1], Number(parts[2]), Number(parts[3]), true)) || rawDate;
    }

    let time: number | null = null;
    const lessThan = /Less than (\d+) minutes?/i.exec(text);
    const clock = /\b(\d{1,2}):(\d{2})\b/.exec(text);
    if (lessThan) time = Number(lessThan[1]) * 60;
    else if (clock) time = Number(clock[1]) * 60 + Number(clock[2]);
    if (!puzzleId || time === null) return null;

    // 60 seconds per mistake (yellow square), 90 per hint (yellow circle).
    const penalty = count(text, "🟨") * 60 + count(text, "🟡") * 90;
    return { puzzleId, score: time + penalty, rawScore: time, penalty };
  },
};

const encloseHorse: GameParser = {
  gameName: "Enclose.Horse",
  ascending: false,
  bucketByDay: false,
  canParse: (text) => text.toLowerCase().includes("enclose.horse") && text.includes("%"),
  parse(text, messageDate) {
    const day = /Day\s*(\d+)/i.exec(text);
    const puzzleId = day ? `Day ${day[1]}` : messageDate;
    const score = /(\d+(?:\.\d+)?)%/.exec(text);
    if (!score) return null;
    return { puzzleId, score: Number(score[1]), rawScore: null, penalty: null };
  },
};

function bracketCity(gameName: string, hardMode: boolean): GameParser {
  return {
    gameName,
    ascending: false,
    bucketByDay: false,
    canParse(text) {
      const lower = text.toLowerCase();
      return lower.includes("[bracket city]") && lower.includes("hard mode!") === hardMode;
    },
    parse(text, messageDate) {
      // "[Bracket City] August 21, 2026" ... "Total Score: 63.1"
      let puzzleId = messageDate;
      const dateMatch = /\]\s*(([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4}))/.exec(text);
      if (dateMatch) {
        puzzleId = isoDate(dateMatch[2], Number(dateMatch[3]), Number(dateMatch[4]), false) ?? dateMatch[1];
      }
      const scoreMatch = /Total Score:\s*([\d.]+)/i.exec(text);
      if (!scoreMatch) return null;
      const score = Number(scoreMatch[1]);
      if (!Number.isFinite(score)) return null;
      return { puzzleId, score, rawScore: null, penalty: null };
    },
  };
}

/** Checked in order; the first parser that recognises a message handles it. */
export const parsers: GameParser[] = [
  boxOffice,
  atlantic,
  timeline,
  cluesBySam,
  encloseHorse,
  bracketCity("Bracket City", false),
  bracketCity("Bracket City (Hard Mode)", true),
];

/** The game a leaderboard command means when run in one of these channels with no game named. */
export const CHANNEL_GAME_MAP: Record<string, string> = {
  "timeline": "Timeline",
  "clues-by-sam": "Clues By Sam",
  "crossword": "Atlantic Daily Crossword",
  "box-office-game": "Box Office Game",
  "enclose-horse": "Enclose.Horse",
  "bracket-city": "Bracket City (Hard Mode)",
};

export function findParser(game: string): GameParser | undefined {
  return parsers.find((p) => p.gameName.toLowerCase() === game.toLowerCase());
}

const easternFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The calendar date in US Eastern time, as YYYY-MM-DD. Discord timestamps are UTC, so
 * a late-evening post would otherwise land on the next day's puzzle.
 */
export function easternDate(date: Date): string {
  return easternFormat.format(date);
}
