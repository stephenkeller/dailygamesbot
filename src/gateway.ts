// The bot's live connection to Discord.
//
// Discord only delivers ordinary chat messages over its Gateway, a WebSocket the bot
// must keep open. A Worker can't hold one, so a single Durable Object does: it stays
// connected, answers heartbeats, and hands each new message to handleMessage.
//
// Staying connected: an alarm fires every 30 seconds and reconnects if the socket is
// gone. Deploys and Cloudflare runtime updates restart the object; the alarm wakes it
// again, and it resumes the Discord session so nothing sent meanwhile is lost.
//
// Catching up: after every (re)connect the object also reads each game channel's
// history from the last message it handled there, so a longer outage loses nothing
// either. Messages the bot has already marked ✅ are skipped.

import { DurableObject } from "cloudflare:workers";
import { discord, type Env } from "./discord";
import { handleMessage, type ChatMessage } from "./messages";
import { CHANNEL_GAME_MAP } from "./parsers";

const GATEWAY_URL = "wss://gateway.discord.gg";
const GATEWAY_QUERY = "/?v=10&encoding=json";

// Server and channel names, messages in servers, and the text of those messages.
const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

// Close codes that reconnecting can't fix: bad token, or intents not enabled for the bot.
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
// Close codes after which the old session can't be resumed.
const NEW_SESSION_CLOSE_CODES = new Set([4007, 4009]);

const WATCHDOG_MS = 30_000;
const RECONNECT_DELAY_MS = 2_000;
const CONNECT_TIMEOUT_MS = 20_000;
const FATAL_RETRY_MS = 10 * 60_000;
// Messages found in history that are older than this are recorded without a reply.
const SILENT_AFTER_MS = 10 * 60_000;
const HISTORY_PAGE = 100;
const MAX_PAGES_PER_RUN = 50;
const REMEMBERED_MESSAGES = 1000;

interface Session {
  id: string;
  /** Where Discord wants this session resumed. */
  url: string;
}

interface Channel {
  name: string;
  guildId: string;
}

interface GatewayPayload {
  op: number;
  d: any;
  s: number | null;
  t: string | null;
}

export interface GatewayStatus {
  connected: boolean;
  /** When the current connection was established (ISO), if connected. */
  connectedSince: string | null;
  /** When Discord last sent anything (ISO). */
  lastEvent: string | null;
  /** Game channels being watched. */
  watchedChannels: string[];
  /** Set when Discord refused the connection outright (bad token or intents). */
  fatalError: string | null;
}

const isGameChannel = (channel: Channel) => channel.name.toLowerCase() in CHANNEL_GAME_MAP;
const newer = (a: string, b: string) => BigInt(a) > BigInt(b);

export class DiscordGateway extends DurableObject<Env> {
  private socket: WebSocket | null = null;
  private ready = false;
  private connectStartedAt = 0;
  private connectedAt = 0;
  private lastEventAt = 0;

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private firstHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatAcked = true;

  // Kept in storage so a restarted object can resume where it left off.
  private loaded = false;
  private session: Session | null = null;
  private sequence: number | null = null;
  private channels: Record<string, Channel> = {};
  private fatalError: string | null = null;
  private fatalUntil = 0;

  private handled = new Set<string>();
  private catchingUp = false;
  private catchUpUnfinished = false;

  // ---- Entry points -------------------------------------------------------------

  /** Called by the Worker's cron: makes sure the watchdog alarm exists and the bot is connected. */
  async ensureRunning(): Promise<GatewayStatus> {
    await this.load();
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    }
    this.checkConnection();
    return this.status();
  }

  async alarm(): Promise<void> {
    await this.load();
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
    this.checkConnection();
    if (this.ready && this.catchUpUnfinished) await this.catchUp();
  }

  private status(): GatewayStatus {
    const iso = (ms: number) => (ms ? new Date(ms).toISOString() : null);
    return {
      connected: this.ready,
      connectedSince: this.ready ? iso(this.connectedAt) : null,
      lastEvent: iso(this.lastEventAt),
      watchedChannels: Object.values(this.channels).filter(isGameChannel).map((c) => c.name).sort(),
      fatalError: this.fatalError,
    };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.ctx.storage.get(["session", "sequence", "channels"]);
    this.session = (stored.get("session") as Session | undefined) ?? null;
    this.sequence = (stored.get("sequence") as number | undefined) ?? null;
    this.channels = (stored.get("channels") as Record<string, Channel> | undefined) ?? {};
    this.loaded = true;
  }

  // ---- Connection ---------------------------------------------------------------

  private checkConnection(): void {
    if (!this.env.DISCORD_TOKEN) {
      this.fatalError = "DISCORD_TOKEN is not set";
      return;
    }
    if (this.socket) {
      const stuckConnecting = !this.ready && Date.now() - this.connectStartedAt > CONNECT_TIMEOUT_MS;
      if (stuckConnecting || this.socket.readyState !== WebSocket.OPEN && this.ready) this.drop("stalled");
      else return;
    }
    if (Date.now() < this.fatalUntil) return;
    this.openSocket();
  }

  private openSocket(): void {
    this.connectStartedAt = Date.now();
    this.ready = false;
    let socket: WebSocket;
    try {
      socket = new WebSocket((this.session?.url ?? this.env.DISCORD_GATEWAY_URL ?? GATEWAY_URL) + GATEWAY_QUERY);
    } catch (error) {
      console.error("Gateway connect failed:", error);
      return;
    }
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      if (socket !== this.socket) return;
      this.onPayload(socket, JSON.parse(event.data as string) as GatewayPayload).catch((error) => {
        console.error("Gateway event failed:", error);
      });
    });
    socket.addEventListener("close", (event) => {
      if (socket === this.socket) this.onClosed(event.code, event.reason);
    });
    socket.addEventListener("error", () => {
      if (socket === this.socket) this.drop("socket error");
    });
  }

  /** Abandons the current socket and reconnects shortly. The session stays resumable. */
  private drop(reason: string): void {
    const socket = this.socket;
    this.detach();
    console.log(`Gateway connection dropped (${reason}); reconnecting`);
    // Closing with 1000 or 1001 would end the session on Discord's side.
    try { socket?.close(4000, "reconnecting"); } catch { /* already closed */ }
    this.reconnectSoon();
  }

  private onClosed(code: number, reason: string): void {
    this.detach();
    if (FATAL_CLOSE_CODES.has(code)) {
      this.fatalError = `Discord refused the connection (close code ${code}: ${reason})`;
      this.fatalUntil = Date.now() + FATAL_RETRY_MS;
      console.error(this.fatalError);
      return;
    }
    if (NEW_SESSION_CLOSE_CODES.has(code) || code === 1000 || code === 1001) this.forgetSession();
    console.log(`Gateway closed (${code} ${reason}); reconnecting`);
    this.reconnectSoon();
  }

  private detach(): void {
    this.socket = null;
    this.ready = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.firstHeartbeatTimer) clearTimeout(this.firstHeartbeatTimer);
    this.heartbeatTimer = this.firstHeartbeatTimer = null;
    if (this.sequence !== null) void this.ctx.storage.put("sequence", this.sequence);
  }

  private reconnectSoon(): void {
    void this.ctx.storage.setAlarm(Date.now() + RECONNECT_DELAY_MS + Math.random() * 3000);
  }

  private forgetSession(): void {
    this.session = null;
    this.sequence = null;
    void this.ctx.storage.delete(["session", "sequence"]);
  }

  private send(socket: WebSocket, op: number, d: unknown): void {
    socket.send(JSON.stringify({ op, d }));
  }

  private startHeartbeat(socket: WebSocket, intervalMs: number): void {
    const beat = () => {
      if (socket !== this.socket) return;
      // No acknowledgement since the last beat: the connection is dead.
      if (!this.heartbeatAcked) return this.drop("heartbeat not acknowledged");
      this.heartbeatAcked = false;
      this.send(socket, OP_HEARTBEAT, this.sequence);
      if (this.sequence !== null) void this.ctx.storage.put("sequence", this.sequence);
    };
    this.heartbeatAcked = true;
    // Discord asks for the first beat after a random part of the interval.
    this.firstHeartbeatTimer = setTimeout(() => {
      beat();
      this.heartbeatTimer = setInterval(beat, intervalMs);
    }, intervalMs * Math.random());
  }

  // ---- Events from Discord ------------------------------------------------------

  private async onPayload(socket: WebSocket, payload: GatewayPayload): Promise<void> {
    this.lastEventAt = Date.now();
    if (payload.s !== null && payload.s !== undefined) this.sequence = payload.s;

    switch (payload.op) {
      case OP_HELLO:
        this.startHeartbeat(socket, payload.d.heartbeat_interval);
        if (this.session && this.sequence !== null) {
          this.send(socket, OP_RESUME, {
            token: this.env.DISCORD_TOKEN, session_id: this.session.id, seq: this.sequence,
          });
        } else {
          this.send(socket, OP_IDENTIFY, {
            token: this.env.DISCORD_TOKEN,
            intents: INTENTS,
            properties: { os: "cloudflare", browser: "dailygames-bot", device: "dailygames-bot" },
          });
        }
        return;
      case OP_HEARTBEAT:
        this.send(socket, OP_HEARTBEAT, this.sequence);
        return;
      case OP_HEARTBEAT_ACK:
        this.heartbeatAcked = true;
        return;
      case OP_RECONNECT:
        this.drop("Discord asked for a reconnect");
        return;
      case OP_INVALID_SESSION:
        // d is true when the session can still be resumed.
        if (!payload.d) this.forgetSession();
        this.drop("session invalid");
        return;
      case OP_DISPATCH:
        await this.onEvent(payload.t!, payload.d);
        return;
    }
  }

  private async onEvent(type: string, data: any): Promise<void> {
    switch (type) {
      case "READY":
        this.session = { id: data.session_id, url: data.resume_gateway_url };
        // A new session re-sends every server (GUILD_CREATE), so start the channel list afresh.
        this.channels = {};
        void this.ctx.storage.put({ session: this.session, channels: this.channels });
        this.markReady();
        console.log(`Gateway connected as ${data.user?.username}`);
        return;

      case "RESUMED":
        this.markReady();
        console.log("Gateway session resumed");
        await this.catchUp();
        return;

      case "GUILD_CREATE":
        for (const channel of [...(data.channels ?? []), ...(data.threads ?? [])]) {
          this.channels[channel.id] = { name: channel.name ?? "", guildId: data.id };
        }
        void this.ctx.storage.put("channels", this.channels);
        await this.catchUp();
        return;

      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
      case "THREAD_CREATE":
      case "THREAD_UPDATE":
        if (!data.guild_id) return;
        this.channels[data.id] = { name: data.name ?? "", guildId: data.guild_id };
        void this.ctx.storage.put("channels", this.channels);
        return;

      case "CHANNEL_DELETE":
      case "THREAD_DELETE":
        delete this.channels[data.id];
        void this.ctx.storage.put("channels", this.channels);
        return;

      case "MESSAGE_CREATE":
        await this.onMessage(data as ChatMessage);
        return;
    }
  }

  private markReady(): void {
    this.ready = true;
    this.connectedAt = Date.now();
    this.fatalError = null;
    this.fatalUntil = 0;
  }

  // ---- Messages -----------------------------------------------------------------

  /** True the first time a message id is seen; guards against handling one twice. */
  private claim(messageId: string): boolean {
    if (this.handled.has(messageId)) return false;
    this.handled.add(messageId);
    if (this.handled.size > REMEMBERED_MESSAGES) {
      this.handled.delete(this.handled.values().next().value!);
    }
    return true;
  }

  private async onMessage(message: ChatMessage): Promise<void> {
    // Saved before any reply goes out, so a restart never replays this message.
    void this.ctx.storage.put("sequence", this.sequence);
    if (!this.claim(message.id)) return;

    const channel = this.channels[message.channel_id];
    await handleMessage(this.env, message, { channelName: channel?.name, silent: false });

    // Move the channel's catch-up marker, unless a catch-up is working through it now.
    if (channel && isGameChannel(channel) && !this.catchingUp) {
      await this.ctx.storage.put(`cursor:${message.channel_id}`, message.id);
    }
  }

  /**
   * Reads each game channel's history from the last message handled there and
   * processes anything the bot hasn't marked ✅. Recent messages get the normal
   * reply; older ones are recorded quietly. On a channel's first run this walks its
   * whole history, which is how scores missed before the move get picked up.
   */
  private async catchUp(): Promise<void> {
    if (this.catchingUp) return;
    this.catchingUp = true;
    this.catchUpUnfinished = false;
    try {
      for (const [channelId, channel] of Object.entries(this.channels)) {
        if (isGameChannel(channel)) await this.catchUpChannel(channelId, channel);
      }
    } catch (error) {
      this.catchUpUnfinished = true;
      console.error("Catch-up failed; will retry:", error);
    } finally {
      this.catchingUp = false;
    }
  }

  private async catchUpChannel(channelId: string, channel: Channel): Promise<void> {
    const cursorKey = `cursor:${channelId}`;
    let cursor = (await this.ctx.storage.get<string>(cursorKey)) ?? "0";

    for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
      const response = await discord(
        this.env, "GET", `/channels/${channelId}/messages?after=${cursor}&limit=${HISTORY_PAGE}`,
      );
      if (response.status === 403 || response.status === 404) {
        console.warn(`Can't read #${channel.name} (${response.status}); skipping`);
        return;
      }
      if (!response.ok) throw new Error(`History for #${channel.name}: ${response.status}`);

      const messages = await response.json<ChatMessage[]>();
      if (!messages.length) return;
      messages.sort((a, b) => (newer(a.id, b.id) ? 1 : -1));

      for (const message of messages) {
        const alreadyDone = message.reactions?.some((r) => r.me && r.emoji.name === "✅");
        if (alreadyDone || !this.claim(message.id)) continue;
        const silent = Date.now() - Date.parse(message.timestamp) > SILENT_AFTER_MS;
        try {
          await handleMessage(
            this.env, { ...message, guild_id: channel.guildId }, { channelName: channel.name, silent },
          );
        } catch (error) {
          console.error(`Message ${message.id} in #${channel.name} failed:`, error);
        }
      }

      cursor = messages[messages.length - 1].id;
      await this.ctx.storage.put(cursorKey, cursor);
      if (messages.length < HISTORY_PAGE) return;
    }
    // More history than one run handles; the next alarm continues from the cursor.
    this.catchUpUnfinished = true;
  }
}
