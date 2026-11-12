// A stand-in for D1 backed by Node's built-in SQLite, so the real SQL runs in tests.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function testDatabase(): D1Database {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));

  const statement = (sql: string, args: any[] = []) => ({
    bind: (...bound: any[]) => statement(sql, bound),
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: async (statements: any[]) => {
      const results = [];
      for (const s of statements) results.push(await s.run());
      return results;
    },
  } as unknown as D1Database;
}
