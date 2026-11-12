// Slash commands. Discord POSTs each one to /api/interactions, signed with the
// application's key, and expects the answer in the response within three seconds.

import * as database from "./db";
import { discord, displayName, type DiscordUser, type Env } from "./discord";
import { userScoresEmbed, type Embed, type SortBy } from "./leaderboard";
import { leaderboardReply } from "./messages";

const PING = 1;
const APPLICATION_COMMAND = 2;
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const EPHEMERAL = 1 << 6;
const ADMINISTRATOR = 1n << 3n;

interface Member {
  nick?: string | null;
  /** Role ids. */
  roles?: string[];
  /** The member's permissions in the channel, as a decimal bit set. */
  permissions?: string;
  user?: DiscordUser;
}

interface Interaction {
  type: number;
  guild_id?: string;
  channel?: { name?: string };
  member?: Member;
  data?: {
    name: string;
    options?: { name: string; value: string }[];
    resolved?: {
      users?: Record<string, DiscordUser>;
      members?: Record<string, Member>;
    };
  };
}

interface Reply {
  content?: string;
  embed?: Embed;
  /** Shown only to the person who ran the command. */
  ephemeral?: boolean;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** Checks Discord's Ed25519 signature over the timestamp and body. */
async function isFromDiscord(request: Request, body: string, publicKey: string): Promise<boolean> {
  const signature = request.headers.get("X-Signature-Ed25519");
  const timestamp = request.headers.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !/^[0-9a-f]{128}$/i.test(signature)) return false;
  try {
    const key = await crypto.subtle.importKey("raw", hexToBytes(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify("Ed25519", key, hexToBytes(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

export async function handleInteraction(request: Request, env: Env): Promise<Response> {
  const body = await request.text();
  if (!(await isFromDiscord(request, body, env.DISCORD_PUBLIC_KEY))) {
    return new Response("Bad request signature", { status: 401 });
  }
  const interaction = JSON.parse(body) as Interaction;
  if (interaction.type === PING) return Response.json({ type: PONG });
  if (interaction.type !== APPLICATION_COMMAND || !interaction.data) {
    return new Response("Unsupported interaction", { status: 400 });
  }

  let reply: Reply;
  try {
    reply = await runCommand(env, interaction);
  } catch (error) {
    console.error("Command failed:", error);
    reply = { content: "Something went wrong running that command.", ephemeral: true };
  }
  return Response.json({
    type: CHANNEL_MESSAGE,
    data: {
      content: reply.content,
      embeds: reply.embed ? [reply.embed] : undefined,
      flags: reply.ephemeral ? EPHEMERAL : undefined,
    },
  });
}

async function runCommand(env: Env, interaction: Interaction): Promise<Reply> {
  const data = interaction.data!;
  const option = (name: string) => data.options?.find((o) => o.name === name)?.value;
  // The user picked in a "user" option, with their name as shown in this server.
  const pickedUser = () => {
    const id = option("user")!;
    const user = data.resolved?.users?.[id];
    return { id, name: user ? displayName(user, data.resolved?.members?.[id]) : "that user" };
  };

  switch (data.name) {
    case "leaderboard": {
      const sortBy: SortBy = option("sort_by") === "Medals" ? "Medals" : "Average Score";
      return leaderboardReply(
        env.DB, option("game") ?? null, interaction.channel?.name, sortBy,
        "`/leaderboard game: Box Office Game`",
      );
    }

    case "user_scores": {
      const user = pickedUser();
      const scores = await database.getUserScores(env.DB, user.id);
      if (!scores.length) return { content: `No recent scores found for ${user.name}.`, ephemeral: true };
      return { embed: userScoresEmbed(user.name, scores), ephemeral: true };
    }

    case "remove_score": {
      if (!(await isMod(env, interaction))) {
        return {
          content: "You need the 'mod' role or Administrator permissions to use this command.",
          ephemeral: true,
        };
      }
      const user = pickedUser();
      const game = option("game")!;
      const puzzleId = option("puzzle_id")!;
      const deleted = await database.deleteScore(env.DB, user.id, game, puzzleId);
      return deleted
        ? { content: `✅ Removed ${game} score for ${user.name} on puzzle \`${puzzleId}\`.` }
        : { content: `❌ Could not find a ${game} score for ${user.name} on puzzle \`${puzzleId}\`.`, ephemeral: true };
    }

    default:
      return { content: "Unknown command.", ephemeral: true };
  }
}

/** Administrators, and anyone with a role named "mod" (any capitalisation). */
async function isMod(env: Env, interaction: Interaction): Promise<boolean> {
  const member = interaction.member;
  if (!member || !interaction.guild_id) return false;
  if (member.permissions && (BigInt(member.permissions) & ADMINISTRATOR) !== 0n) return true;
  if (!member.roles?.length) return false;

  // The command carries role ids only, so fetch the server's roles to match by name.
  const response = await discord(env, "GET", `/guilds/${interaction.guild_id}/roles`);
  if (!response.ok) return false;
  const roles = await response.json<{ id: string; name: string }[]>();
  return roles.some((role) => role.name.toLowerCase() === "mod" && member.roles!.includes(role.id));
}
