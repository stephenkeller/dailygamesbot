// Calls to Discord's REST API, made as the bot.

import type { DiscordGateway } from "./gateway";
import type { Embed } from "./leaderboard";

export interface Env {
  DB: D1Database;
  GATEWAY: DurableObjectNamespace<DiscordGateway>;
  /** Bot token (secret). */
  DISCORD_TOKEN: string;
  /** The application's public key, used to verify slash-command requests (secret). */
  DISCORD_PUBLIC_KEY: string;
  /** Test only: point the bot at a stand-in for Discord (scripts/fake-discord.mjs). */
  DISCORD_API_URL?: string;
  DISCORD_GATEWAY_URL?: string;
  /** "true" stops the bot reading channel history (set in wrangler.jsonc). */
  BACKFILL_PAUSED?: string;
}

const API = "https://discord.com/api/v10";
const CHECK_MARK = encodeURIComponent("✅");
const SUPPRESS_EMBEDS = 1 << 2;

/** One REST call. Waits and retries when Discord says the bot is going too fast. */
export async function discord(env: Env, method: string, path: string, body?: unknown): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch((env.DISCORD_API_URL ?? API) + path, {
      method,
      headers: {
        "Authorization": `Bot ${env.DISCORD_TOKEN}`,
        "User-Agent": "DiscordBot (dailygames, 1.0)",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status !== 429 || attempt >= 3) return response;
    const info = await response.json<{ retry_after?: number }>().catch(() => ({ retry_after: 1 }));
    const seconds = Math.min(info.retry_after ?? 1, 10);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000 + 100));
  }
}

async function attempt(what: string, call: Promise<Response>): Promise<void> {
  try {
    const response = await call;
    if (!response.ok) console.warn(`${what} failed: ${response.status} ${await response.text()}`);
  } catch (error) {
    console.warn(`${what} failed:`, error);
  }
}

/** Hides a message's link previews. Needs the Manage Messages permission; ignored without it. */
export function suppressEmbeds(env: Env, channelId: string, messageId: string, currentFlags = 0): Promise<void> {
  return attempt("Suppress embeds", discord(env, "PATCH", `/channels/${channelId}/messages/${messageId}`, {
    flags: currentFlags | SUPPRESS_EMBEDS,
  }));
}

export function addCheckMark(env: Env, channelId: string, messageId: string): Promise<void> {
  return attempt("Add reaction", discord(
    env, "PUT", `/channels/${channelId}/messages/${messageId}/reactions/${CHECK_MARK}/@me`,
  ));
}

export interface OutgoingMessage {
  content?: string;
  embed?: Embed;
  /** Post as a reply to this message. */
  replyTo?: string;
}

export function sendMessage(env: Env, channelId: string, message: OutgoingMessage): Promise<void> {
  return attempt("Send message", discord(env, "POST", `/channels/${channelId}/messages`, {
    content: message.content,
    embeds: message.embed ? [message.embed] : undefined,
    message_reference: message.replyTo
      ? { message_id: message.replyTo, fail_if_not_exists: false }
      : undefined,
  }));
}

interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}

/** The name Discord shows for someone in a server: nickname, else display name, else username. */
export function displayName(user: DiscordUser, member?: { nick?: string | null } | null): string {
  return member?.nick || user.global_name || user.username;
}

/** Looks up a server member's display name; falls back to `user` if they have left. */
export async function fetchDisplayName(env: Env, guildId: string, user: DiscordUser): Promise<string> {
  try {
    const response = await discord(env, "GET", `/guilds/${guildId}/members/${user.id}`);
    if (response.ok) {
      const member = await response.json<{ nick?: string | null; user?: DiscordUser }>();
      return displayName(member.user ?? user, member);
    }
  } catch (error) {
    console.warn("Member lookup failed:", error);
  }
  return displayName(user);
}

export type { DiscordUser };
