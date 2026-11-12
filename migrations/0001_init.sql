-- Schema carried over unchanged from the Fly.io SQLite database, so its rows import as-is.
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    username TEXT
);

CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    game_name TEXT,
    puzzle_id TEXT,
    score REAL,
    raw_score REAL,
    penalty REAL,
    date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, game_name, puzzle_id)
);
