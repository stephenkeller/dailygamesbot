// Registers the bot's slash commands with Discord. Run it only when a command's name,
// description or options change:
//
//   npm run commands:register
//
// Reads DISCORD_TOKEN from the environment, or from .dev.vars in this folder.

import { readFileSync } from "node:fs";

function token() {
  if (process.env.DISCORD_TOKEN) return process.env.DISCORD_TOKEN;
  try {
    const line = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
      .split(/\r?\n/).find((l) => l.startsWith("DISCORD_TOKEN="));
    if (line) return line.slice("DISCORD_TOKEN=".length).trim().replace(/^"|"$/g, "");
  } catch { /* no .dev.vars */ }
  console.error("Set DISCORD_TOKEN in the environment or in .dev.vars.");
  process.exit(1);
}

const STRING = 3;
const USER = 6;

const commands = [
  {
    name: "leaderboard",
    description: "Show the leaderboard for a specific game",
    options: [
      { type: STRING, name: "game", description: "The name of the game (e.g., 'Box Office Game', 'Timeline')", required: false },
      {
        type: STRING, name: "sort_by", description: "How to sort the leaderboard", required: false,
        choices: [{ name: "Average Score", value: "Average Score" }, { name: "Medals", value: "Medals" }],
      },
    ],
  },
  {
    name: "user_scores",
    description: "View a user's recent score history",
    options: [{ type: USER, name: "user", description: "The user to look up", required: true }],
  },
  {
    name: "remove_score",
    description: "Mod: Remove a specific score for a user",
    options: [
      { type: USER, name: "user", description: "The user whose score to remove", required: true },
      { type: STRING, name: "game", description: "The name of the game", required: true },
      { type: STRING, name: "puzzle_id", description: "The ID of the puzzle (e.g., '193' or '2026-08-08')", required: true },
    ],
  },
];

const api = "https://discord.com/api/v10";
const headers = { "Authorization": `Bot ${token()}`, "Content-Type": "application/json" };

const app = await fetch(`${api}/applications/@me`, { headers });
if (!app.ok) {
  console.error(`Could not read the application: ${app.status} ${await app.text()}`);
  process.exit(1);
}
const { id } = await app.json();

const response = await fetch(`${api}/applications/${id}/commands`, {
  method: "PUT", headers, body: JSON.stringify(commands),
});
if (!response.ok) {
  console.error(`Registering failed: ${response.status} ${await response.text()}`);
  process.exit(1);
}
console.log(`Registered ${(await response.json()).length} commands.`);
