// A stand-in for Discord, for testing the bot locally without touching the real one.
// It plays a short script against a local `wrangler dev` and prints everything the bot
// does: connect, catch up on history, handle live messages, survive a dropped
// connection, and answer slash commands.
//
//   1. node scripts/fake-discord.mjs
//   2. In another terminal (values are test-only):
//      npx wrangler d1 migrations apply dailygames-db --local
//      npx wrangler dev --var DISCORD_TOKEN:test --var DISCORD_PUBLIC_KEY:<printed by step 1>
//          --var DISCORD_API_URL:http://127.0.0.1:8799/api --var DISCORD_GATEWAY_URL:ws://127.0.0.1:8799
//   3. Open http://127.0.0.1:8787/ once to start the bot.

import crypto from "node:crypto";
import http from "node:http";
import { WebSocketServer } from "ws";

const PORT = 8799;
const WORKER = "http://127.0.0.1:8787";
const GUILD = "9000";
const TIMELINE = "100";
const GENERAL = "200";

// A fixed test key, so the public half can be passed to wrangler dev up front.
const privateKey = crypto.createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 7)]),
  format: "der",
  type: "pkcs8",
});
const publicKeyHex = crypto.createPublicKey(privateKey)
  .export({ format: "der", type: "spki" }).subarray(-32).toString("hex");

const log = (...parts) => console.log(new Date().toISOString().slice(11, 23), ...parts);
const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();
const user = (id) => ({ id, username: `user${id}`, global_name: `Global ${id}` });

// Channel history. 1000 was missed long ago, 1001 was already handled, 1002 is recent.
const history = {
  [TIMELINE]: [
    { id: "1000", content: "Timeline 🗓️ #192\nTotal: 400/600", timestamp: minutesAgo(5000), author: user("1") },
    { id: "1001", content: "Timeline 🗓️ #192\nTotal: 450/600", timestamp: minutesAgo(4990), author: user("2"),
      reactions: [{ me: true, emoji: { name: "✅" } }] },
    { id: "1002", content: "Timeline 🗓️ #193\nTotal: 528/600", timestamp: minutesAgo(1), author: user("1") },
    { id: "1003", content: "bot reply", timestamp: minutesAgo(1), author: { ...user("99"), bot: true } },
  ],
  [GENERAL]: [],
};

// ---- REST ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const url = new URL(req.url, "http://x");
  const path = url.pathname.replace(/^\/api/, "");
  const send = (status, json) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(json === undefined ? "" : JSON.stringify(json));
  };
  let match;

  if (req.method === "GET" && (match = /^\/channels\/(\d+)\/messages$/.exec(path))) {
    const after = BigInt(url.searchParams.get("after"));
    const page = (history[match[1]] ?? []).filter((m) => BigInt(m.id) > after).slice(0, 100).reverse();
    log(`REST  history #${match[1]} after=${after} -> ${page.map((m) => m.id).join(",") || "none"}`);
    return send(200, page.map((m) => ({ ...m, channel_id: match[1] })));
  }
  if (req.method === "PATCH" && (match = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(path))) {
    log(`REST  edit message ${match[2]}: ${body}`);
    return send(200, {});
  }
  if (req.method === "PUT" && (match = /^\/channels\/(\d+)\/messages\/(\d+)\/reactions\/(.+)\/@me$/.exec(path))) {
    log(`REST  react ${decodeURIComponent(match[3])} on ${match[2]}`);
    const message = history[match[1]]?.find((m) => m.id === match[2]);
    if (message) message.reactions = [{ me: true, emoji: { name: decodeURIComponent(match[3]) } }];
    return send(204);
  }
  if (req.method === "POST" && (match = /^\/channels\/(\d+)\/messages$/.exec(path))) {
    const message = JSON.parse(body);
    const embed = message.embeds?.[0];
    log(`REST  post in #${match[1]}${message.message_reference ? ` (reply to ${message.message_reference.message_id})` : ""}:`,
      JSON.stringify(message.content ?? { title: embed.title, description: embed.description, fields: embed.fields }));
    return send(200, { id: "5000" });
  }
  if (req.method === "GET" && (match = /^\/guilds\/(\d+)\/members\/(\d+)$/.exec(path))) {
    log(`REST  member ${match[2]}`);
    return send(200, { nick: `Nick ${match[2]}`, user: user(match[2]) });
  }
  if (req.method === "GET" && /^\/guilds\/\d+\/roles$/.test(path)) {
    log("REST  roles");
    return send(200, [{ id: "r1", name: "Mod" }, { id: "r2", name: "other" }]);
  }
  log(`REST  UNEXPECTED ${req.method} ${req.url}`);
  send(404, {});
});

// ---- Gateway ------------------------------------------------------------------------

const wss = new WebSocketServer({ server });
let sequence = 0;
let connections = 0;
let heartbeats = 0;

wss.on("connection", (socket) => {
  const connection = ++connections;
  log(`GW    connection ${connection} opened`);
  const dispatch = (t, d) => socket.send(JSON.stringify({ op: 0, t, d, s: ++sequence }));
  const live = (channel, message) => {
    history[channel].push(message);
    dispatch("MESSAGE_CREATE", {
      ...message, channel_id: channel, guild_id: GUILD, member: { nick: `Nick ${message.author.id}` },
    });
  };
  socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 2000 } }));

  socket.on("close", (code) => log(`GW    connection ${connection} closed (${code})`));
  socket.on("message", (raw) => {
    const { op, d } = JSON.parse(raw);
    if (op === 1) {
      heartbeats++;
      return socket.send(JSON.stringify({ op: 11 }));
    }
    if (op === 2) {
      log(`GW    IDENTIFY intents=${d.intents} token=${d.token}`);
      dispatch("READY", { session_id: "session-1", resume_gateway_url: `ws://127.0.0.1:${PORT}`, user: user("99") });
      dispatch("GUILD_CREATE", {
        id: GUILD,
        channels: [{ id: TIMELINE, name: "timeline" }, { id: GENERAL, name: "general" }],
      });
      setTimeout(() => live(TIMELINE, {
        id: "2000", content: "Timeline 🗓️ #193\nTotal: 560/600", timestamp: new Date().toISOString(), author: user("2"),
      }), 3000);
      setTimeout(() => live(TIMELINE, {
        id: "2001", content: "!leaderboard medals", timestamp: new Date().toISOString(), author: user("2"),
      }), 4500);
      setTimeout(() => live(GENERAL, {
        id: "2002", content: "!leaderboard", timestamp: new Date().toISOString(), author: user("2"),
      }), 5500);
      setTimeout(() => {
        // Posted while the bot is disconnected: it must find this one in history.
        history[TIMELINE].push({
          id: "2003", content: "Timeline 🗓️ #193\nTotal: 560/600", timestamp: new Date().toISOString(), author: user("3"),
        });
        log("GW    dropping the connection");
        socket.terminate();
      }, 7500);
      return;
    }
    if (op === 6) {
      log(`GW    RESUME session=${d.session_id} seq=${d.seq} (server is at ${sequence})`);
      dispatch("RESUMED", {});
      setTimeout(runCommands, 3000);
    }
  });
});

// ---- Slash commands -----------------------------------------------------------------

async function command(label, data, member, sign = true) {
  const body = JSON.stringify({
    type: 2, guild_id: GUILD, channel: { name: "timeline" }, member, data,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign
    ? crypto.sign(null, Buffer.from(timestamp + body), privateKey).toString("hex")
    : "00".repeat(64);
  const response = await fetch(`${WORKER}/api/interactions`, {
    method: "POST",
    headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": timestamp },
    body,
  });
  log(`CMD   ${label} -> ${response.status}`, await response.text());
}

async function runCommands() {
  const plain = { roles: ["r2"], permissions: "0", user: user("2") };
  const mod = { roles: ["r1"], permissions: "0", user: user("5") };
  const picked = { options: [{ name: "user", value: "1" }], resolved: { users: { 1: user("1") }, members: { 1: { nick: "Nick 1" } } } };
  await command("bad signature", { name: "leaderboard" }, plain, false);
  await command("/leaderboard (channel default)", { name: "leaderboard" }, plain);
  await command("/leaderboard game:chess", { name: "leaderboard", options: [{ name: "game", value: "chess" }] }, plain);
  await command("/user_scores", { name: "user_scores", ...picked }, plain);
  const remove = {
    name: "remove_score",
    options: [...picked.options, { name: "game", value: "Timeline" }, { name: "puzzle_id", value: "192" }],
    resolved: picked.resolved,
  };
  await command("/remove_score as non-mod", remove, plain);
  await command("/remove_score as mod", remove, mod);
  await command("/remove_score again", remove, mod);
  const status = await fetch(WORKER + "/");
  log("STATUS", await status.text());
  log(`Done. Heartbeats received: ${heartbeats}, connections: ${connections}`);
  process.exit(0);
}

server.listen(PORT, () => {
  console.log(`Fake Discord on port ${PORT}. DISCORD_PUBLIC_KEY for wrangler dev: ${publicKeyHex}`);
});
