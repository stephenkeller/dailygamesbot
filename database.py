import aiosqlite
import logging
from collections import defaultdict
from typing import Dict, List, Tuple
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
import os

os.makedirs("data", exist_ok=True)
DB_FILE = "data/scores.db"

async def init_db():
    async with aiosqlite.connect(DB_FILE) as db:
        await db.execute('''
            CREATE TABLE IF NOT EXISTS users (
                user_id TEXT PRIMARY KEY,
                username TEXT
            )
        ''')
        await db.execute('''
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
            )
        ''')
        
        # Migration: Add columns if table already exists
        try:
            await db.execute("ALTER TABLE scores ADD COLUMN raw_score REAL")
        except aiosqlite.OperationalError:
            pass
            
        try:
            await db.execute("ALTER TABLE scores ADD COLUMN penalty REAL")
        except aiosqlite.OperationalError:
            pass
        
        # Migration: fix old Clues By Sam dates
        cursor = await db.execute("SELECT user_id, game_name, puzzle_id FROM scores WHERE game_name = 'Clues By Sam'")
        rows = await cursor.fetchall()
        for row in rows:
            puzzle_id = row[2]
            if not re.match(r'^\d{4}-\d{2}-\d{2}$', puzzle_id):
                clean_date = re.sub(r'(st|nd|rd|th)', '', puzzle_id)
                try:
                    new_id = datetime.strptime(clean_date, "%b %d %Y").strftime("%Y-%m-%d")
                    await db.execute(
                        "UPDATE OR REPLACE scores SET puzzle_id = ? WHERE user_id = ? AND game_name = ? AND puzzle_id = ?",
                        (new_id, row[0], row[1], puzzle_id)
                    )
                except ValueError:
                    pass
                    
        # Migration: Box Office Game repeats
        cursor = await db.execute("SELECT puzzle_id, MIN(date) FROM scores WHERE game_name = 'Box Office Game' AND puzzle_id NOT LIKE '%|%' GROUP BY puzzle_id")
        rows = await cursor.fetchall()
        for row in rows:
            old_puzzle_id = row[0]
            try:
                dt = datetime.strptime(row[1], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
                eastern_dt = dt.astimezone(ZoneInfo("America/New_York"))
                new_date_str = eastern_dt.strftime("%Y-%m-%d")
            except Exception:
                new_date_str = row[1][:10]
            new_puzzle_id = f"{old_puzzle_id}|{new_date_str}"
            await db.execute(
                "UPDATE OR REPLACE scores SET puzzle_id = ? WHERE game_name = 'Box Office Game' AND puzzle_id = ?",
                (new_puzzle_id, old_puzzle_id)
            )

        await db.commit()
    logging.info("Database initialized.")

async def record_score(user_id: str, username: str, game_name: str, puzzle_id: str, score: float, raw_score: float = None, penalty: float = None):
    async with aiosqlite.connect(DB_FILE) as db:
        # Update user info
        await db.execute('''
            INSERT INTO users (user_id, username) 
            VALUES (?, ?)
            ON CONFLICT(user_id) DO UPDATE SET username = excluded.username
        ''', (user_id, username))
        
        await db.execute('''
            INSERT INTO scores (user_id, game_name, puzzle_id, score, raw_score, penalty)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(user_id, game_name, puzzle_id) DO UPDATE SET 
                score = excluded.score, 
                raw_score = excluded.raw_score, 
                penalty = excluded.penalty
        ''', (user_id, game_name, puzzle_id, score, raw_score, penalty))
        
        await db.commit()

async def get_leaderboard(game_name: str, ascending: bool = False):
    """
    Returns the leaderboard for a specific game.
    If ascending is True, a lower score is better (e.g., time taken).
    If ascending is False, a higher score is better.
    """
    order = "ASC" if ascending else "DESC"
    async with aiosqlite.connect(DB_FILE) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(f'''
            SELECT u.username, COUNT(s.id) as plays, AVG(s.score) as avg_score, AVG(s.raw_score) as avg_raw, AVG(s.penalty) as avg_penalty
            FROM scores s
            JOIN users u ON s.user_id = u.user_id
            WHERE s.game_name = ?
            GROUP BY s.user_id
            ORDER BY avg_score {order}
        ''', (game_name,))
        rows = await cursor.fetchall()
        return rows

async def get_puzzle_leaderboard(game_name: str, puzzle_id: str, ascending: bool = False):
    order = "ASC" if ascending else "DESC"
    async with aiosqlite.connect(DB_FILE) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(f'''
            SELECT u.username, s.score, s.raw_score, s.penalty, s.user_id
            FROM scores s
            JOIN users u ON s.user_id = u.user_id
            WHERE s.game_name = ? AND s.puzzle_id = ?
            ORDER BY s.score {order}, s.date ASC
        ''', (game_name, puzzle_id))
        return await cursor.fetchall()

async def get_medal_counts(game_name: str, ascending: bool = False):
    """
    Calculates medals by ranking scores per puzzle, allowing ties.
    Returns a dict mapping username to {'1st': 0, '2nd': 0, '3rd': 0}
    """
    order_desc = not ascending
    async with aiosqlite.connect(DB_FILE) as db:
        db.row_factory = aiosqlite.Row
        # Get all scores for the game joined with users
        query = '''
            SELECT s.puzzle_id, u.username, s.score
            FROM scores s
            JOIN users u ON s.user_id = u.user_id
            WHERE s.game_name = ?
        '''
        cursor = await db.execute(query, (game_name,))
        all_scores = await cursor.fetchall()
        
    # Group by puzzle
    from collections import defaultdict
    puzzles = defaultdict(list)
    for row in all_scores:
        puzzles[row['puzzle_id']].append(row)
        
    medals = defaultdict(lambda: {'1st': 0, '2nd': 0, '3rd': 0})
    
    for puzzle_id, scores in puzzles.items():
        # Sort scores
        scores.sort(key=lambda x: x['score'], reverse=order_desc)
        
        if not scores: continue
        
        # Assign ranks with ties
        current_rank = 1
        current_score = scores[0]['score']
        
        for i, score_row in enumerate(scores):
            if score_row['score'] != current_score:
                # Standard competition ranking (1, 2, 2, 4...)
                current_rank = i + 1
                current_score = score_row['score']
                
            if current_rank == 1:
                medals[score_row['username']]['1st'] += 1
            elif current_rank == 2:
                medals[score_row['username']]['2nd'] += 1
            elif current_rank == 3:
                medals[score_row['username']]['3rd'] += 1
                
    return dict(medals)

async def get_bucketed_leaderboard(game_name: str, ascending: bool = False):
    """
    Returns a dict mapping day of week (Monday, Tuesday...) to a list of dicts:
    [{username, avg_score, plays}, ...]
    """
    order = "ASC" if ascending else "DESC"
    async with aiosqlite.connect(DB_FILE) as db:
        db.row_factory = aiosqlite.Row
        
        cursor = await db.execute(f'''
            SELECT 
                u.username, 
                COUNT(s.id) as plays, 
                AVG(s.score) as avg_score,
                AVG(s.raw_score) as avg_raw,
                AVG(s.penalty) as avg_penalty,
                CASE CAST(strftime('%w', s.puzzle_id) AS INTEGER)
                    WHEN 0 THEN 'Sunday'
                    WHEN 1 THEN 'Monday'
                    WHEN 2 THEN 'Tuesday'
                    WHEN 3 THEN 'Wednesday'
                    WHEN 4 THEN 'Thursday'
                    WHEN 5 THEN 'Friday'
                    WHEN 6 THEN 'Saturday'
                END as day_of_week
            FROM scores s
            JOIN users u ON s.user_id = u.user_id
            WHERE s.game_name = ?
            GROUP BY s.user_id, day_of_week
            ORDER BY day_of_week, avg_score {order}
        ''', (game_name,))
        rows = await cursor.fetchall()
        
    days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    bucketed = {day: [] for day in days}
    
    for row in rows:
        dow = row['dow']
        if dow is not None and 0 <= dow <= 6:
            day_name = days[dow]
            bucketed[day_name].append({
                'username': row['username'],
                'avg_score': row['avg_score'],
                'plays': row['plays']
            })
            
    return bucketed

async def get_bucketed_medal_counts(game_name: str, ascending: bool = False):
    """
    Returns a dict mapping username to a dict of medal counts per day and globally:
    {'username': {'global': {'1st': 0...}, 'Monday': {'1st': 0...}, ...}}
    """
    order_desc = not ascending
    async with aiosqlite.connect(DB_FILE) as db:
        db.row_factory = aiosqlite.Row
        query = '''
            SELECT s.puzzle_id, u.username, s.score,
                   CAST(strftime('%w', s.puzzle_id) AS INTEGER) as dow
            FROM scores s
            JOIN users u ON s.user_id = u.user_id
            WHERE s.game_name = ?
        '''
        cursor = await db.execute(query, (game_name,))
        all_scores = await cursor.fetchall()
        
    days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
    from collections import defaultdict
    puzzles = defaultdict(list)
    for row in all_scores:
        puzzles[row['puzzle_id']].append(row)
        
    # Default dict setup
    def default_medals():
        return {'1st': 0, '2nd': 0, '3rd': 0}
        
    medals = defaultdict(lambda: defaultdict(default_medals))
    
    for puzzle_id, scores in puzzles.items():
        dow = scores[0]['dow']
        day_name = days[dow] if dow is not None and 0 <= dow <= 6 else None
        
        scores.sort(key=lambda x: x['score'], reverse=order_desc)
        if not scores: continue
        
        current_rank = 1
        current_score = scores[0]['score']
        
        for i, score_row in enumerate(scores):
            if score_row['score'] != current_score:
                current_rank = i + 1
                current_score = score_row['score']
                
            username = score_row['username']
            if current_rank == 1:
                medals[username]['global']['1st'] += 1
                if day_name: medals[username][day_name]['1st'] += 1
            elif current_rank == 2:
                medals[username]['global']['2nd'] += 1
                if day_name: medals[username][day_name]['2nd'] += 1
            elif current_rank == 3:
                medals[username]['global']['3rd'] += 1
                if day_name: medals[username][day_name]['3rd'] += 1
                    
    # Convert back to regular dicts
    return {user: dict(data) for user, data in medals.items()}

async def delete_score(user_id: str, game_name: str, puzzle_id: str) -> bool:
    """Deletes a specific score and returns True if a row was deleted."""
    async with aiosqlite.connect(DB_FILE) as db:
        cursor = await db.execute(
            "DELETE FROM scores WHERE user_id = ? AND game_name = ? AND puzzle_id = ?",
            (user_id, game_name, puzzle_id)
        )
        deleted = cursor.rowcount > 0
        await db.commit()
        return deleted

async def get_user_scores(user_id: str, limit: int = 15):
    """Returns the most recent scores for a specific user."""
    async with aiosqlite.connect(DB_FILE) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute('''
            SELECT game_name, puzzle_id, score, raw_score, penalty, date
            FROM scores
            WHERE user_id = ?
            ORDER BY date DESC
            LIMIT ?
        ''', (user_id, limit))
        return await cursor.fetchall()

async def resolve_box_office_puzzle_id(movie_date: str) -> str:
    """Groups Box Office Game repeats if they occur within 7 days in Eastern Time."""
    async with aiosqlite.connect(DB_FILE) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT puzzle_id, MAX(date) as last_played FROM scores WHERE game_name = 'Box Office Game' AND puzzle_id LIKE ? GROUP BY puzzle_id ORDER BY last_played DESC LIMIT 1",
            (f"{movie_date}|%",)
        )
        row = await cursor.fetchone()
        
        eastern = ZoneInfo("America/New_York")
        now_eastern = datetime.now(timezone.utc).astimezone(eastern)
        
        if row:
            last_played_str = row['last_played']
            last_played_utc = datetime.strptime(last_played_str, "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            last_played_eastern = last_played_utc.astimezone(eastern)
            
            if (now_eastern - last_played_eastern).days <= 7:
                return row['puzzle_id']
                
        return f"{movie_date}|{now_eastern.strftime('%Y-%m-%d')}"
