// What the bot does with one chat message: record a pasted score, or answer
// `!leaderboard`.

import * as database from "./db";
import {
  addCheckMark, displayName, fetchDisplayName, sendMessage, suppressEmbeds,
  type DiscordUser, type Env,
} from "./discord";
import { dailyRankEmbed, leaderboardEmbed, type Embed, type SortBy } from "./leaderboard";
import { CHANNEL_GAME_MAP, easternDate, findParser, parsers } from "./parsers";

/** A message as Discord sends it, live (Gateway) or from channel history (REST). */
export interface ChatMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  /** ISO time the message was posted. */
  timestamp: string;
  flags?: number;
  author: DiscordUser;
  /** Present on live messages only. */
  member?: { nick?: string | null };
  /** Present on messages read from history. */
  reactions?: { me: boolean; emoji: { name: string | null } }[];
}

export interface MessageContext {
  /** Name of the channel the message is in, if known. */
  channelName?: string;
  /**
   * True for an old message found while catching up: record the score and mark it ✅,
   * but don't reply or run commands.
   */
  silent: boolean;
}

export async function handleMessage(env: Env, message: ChatMessage, context: MessageContext): Promise<void> {
  if (message.author.bot || !message.content) return;
  await recordSharedScore(env, message, context);
  if (!context.silent) await runTextCommand(env, message, context);
}

async function recordSharedScore(env: Env, message: ChatMessage, context: MessageContext): Promise<void> {
  const text = message.content;
  const parser = parsers.find((p) => p.canParse(text));
  if (!parser) return;

  const postedAt = new Date(message.timestamp);
  const postedDate = easternDate(postedAt);
  const result = parser.parse(text, postedDate);
  if (!result) return;

  let puzzleId = result.puzzleId;
  if (parser.gameName === "Box Office Game") {
    puzzleId = await database.resolveBoxOfficePuzzleId(env.DB, puzzleId, postedAt, postedDate);
  }

  // History doesn't include the poster's server nickname, so look it up.
  const username = message.member || !message.guild_id
    ? displayName(message.author, message.member)
    : await fetchDisplayName(env, message.guild_id, message.author);

  await database.recordScore(env.DB, {
    userId: message.author.id,
    username,
    gameName: parser.gameName,
    puzzleId,
    score: result.score,
    rawScore: result.rawScore,
    penalty: result.penalty,
    postedAt,
  });

  if (!context.silent) await suppressEmbeds(env, message.channel_id, message.id, message.flags);
  await addCheckMark(env, message.channel_id, message.id);
  if (context.silent) return;

  const ranks = await database.getPuzzleLeaderboard(env.DB, parser.gameName, puzzleId, parser.ascending);
  if (ranks.length) {
    await sendMessage(env, message.channel_id, {
      embed: dailyRankEmbed(parser, puzzleId, ranks, message.author.id),
      replyTo: message.id,
    });
  }
}

/** Splits "!leaderboard Bracket City medals" into the game named (if any) and the sort order. */
export function parseLeaderboardCommand(content: string): { game: string | null; sortBy: SortBy } | null {
  const match = /^!leaderboard(?:\s+([\s\S]*))?$/.exec(content);
  if (!match) return null;
  let game = (match[1] ?? "").trim();
  let sortBy: SortBy = "Average Score";
  if (game.toLowerCase().endsWith("medals")) {
    sortBy = "Medals";
    game = game.slice(0, -"medals".length).trim();
    if (game.endsWith("-")) game = game.slice(0, -1).trim();
  }
  return { game: game || null, sortBy };
}

/**
 * Builds the reply to a leaderboard command. With no game named, uses the game that
 * belongs to the channel. `example` is shown when neither gives a game.
 */
export async function leaderboardReply(
  db: D1Database, game: string | null, channelName: string | undefined, sortBy: SortBy, example: string,
): Promise<{ content?: string; embed?: Embed }> {
  game ??= CHANNEL_GAME_MAP[(channelName ?? "").toLowerCase()] ?? null;
  if (!game) return { content: `Please specify a game! Example: ${example}` };

  const parser = findParser(game);
  if (!parser) {
    return { content: `Game not found. Supported games: ${parsers.map((p) => p.gameName).join(", ")}` };
  }
  const embed = await leaderboardEmbed(db, parser, sortBy);
  if (!embed) return { content: `No scores recorded for ${parser.gameName} yet.` };
  return { embed };
}

async function runTextCommand(env: Env, message: ChatMessage, context: MessageContext): Promise<void> {
  const command = parseLeaderboardCommand(message.content);
  if (!command) return;
  const reply = await leaderboardReply(
    env.DB, command.game, context.channelName, command.sortBy,
    "`!leaderboard Box Office Game` or `!leaderboard medals`",
  );
  await sendMessage(env, message.channel_id, reply);
}
