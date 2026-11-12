// One-time move from Fly.io: turns the old bot's SQLite file into SQL that D1 can load.
//
//   node scripts/export-sqlite.mjs data/scores.db data/import.sql
//   npx wrangler d1 execute dailygames-db --remote --file data/import.sql
//
// The target tables must exist and be empty (npm run db:migrate:remote).

import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const [source = "data/scores.db", target = "data/import.sql"] = process.argv.slice(2);
const db = new DatabaseSync(source, { readOnly: true });

const literal = (value) => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  return `'${String(value).replaceAll("'", "''")}'`;
};

function inserts(table, columns) {
  const rows = db.prepare(`SELECT ${columns.join(", ")} FROM ${table} ORDER BY 1`).all();
  const lines = rows.map((row) =>
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map((c) => literal(row[c])).join(", ")});`);
  console.log(`${table}: ${rows.length} rows`);
  return lines;
}

const sql = [
  ...inserts("users", ["user_id", "username"]),
  ...inserts("scores", ["id", "user_id", "game_name", "puzzle_id", "score", "raw_score", "penalty", "date"]),
];
writeFileSync(target, sql.join("\n") + "\n");
console.log(`Wrote ${target}`);

// The old bot tidied these up each time it started; the new one expects them already tidy.
const count = (where) => db.prepare(`SELECT COUNT(*) AS n FROM scores WHERE ${where}`).get().n;
const undatedClues = count("game_name = 'Clues By Sam' AND puzzle_id NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'");
const ungroupedBoxOffice = count("game_name = 'Box Office Game' AND puzzle_id NOT LIKE '%|%'");
if (undatedClues) console.warn(`Check: ${undatedClues} Clues By Sam scores whose puzzle id is not a YYYY-MM-DD date.`);
if (ungroupedBoxOffice) console.warn(`Check: ${ungroupedBoxOffice} Box Office scores without a "|date" group suffix.`);

console.log("\nPer game:");
for (const row of db.prepare("SELECT game_name, COUNT(*) AS n FROM scores GROUP BY game_name ORDER BY 1").all()) {
  console.log(`  ${row.game_name}: ${row.n}`);
}
