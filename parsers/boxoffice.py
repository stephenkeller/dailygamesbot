import re
from typing import Optional, Tuple
from datetime import datetime
from parsers.base import GameParser

class BoxOfficeParser(GameParser):
    @property
    def game_name(self) -> str:
        return "Box Office Game"

    def can_parse(self, text: str) -> bool:
        return "boxofficega.me" in text and "🏆" in text

    def parse(self, text: str, message_date: datetime) -> Optional[Tuple[str, float, Optional[float], Optional[float]]]:
        lines = [line.strip() for line in text.split('\n') if line.strip()]
        
        puzzle_id = None
        score = None
        
        # Typically, line 0 is "boxofficega.me", line 1 is the date (puzzle ID)
        for i, line in enumerate(lines):
            if line == "boxofficega.me" and i + 1 < len(lines):
                puzzle_id = lines[i + 1]
            
            if line.startswith("🏆"):
                # E.g., "🏆 800"
                match = re.search(r'🏆\s*(\d+)', line)
                if match:
                    score = float(match.group(1))
        
        if puzzle_id and score is not None:
            return puzzle_id, score, None, None
        return None
