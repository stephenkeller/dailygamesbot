import re
from typing import Optional, Tuple
from datetime import datetime
from parsers.base import GameParser

class AtlanticCrosswordParser(GameParser):
    @property
    def game_name(self) -> str:
        return "Atlantic Daily Crossword"

    @property
    def ascending(self) -> bool:
        return True  # Lower time is better
        
    @property
    def bucket_by_day(self) -> bool:
        return True

    def can_parse(self, text: str) -> bool:
        return "I completed the Crossword in" in text and "The Atlantic" in text

    def parse(self, text: str, message_date: datetime) -> Optional[Tuple[str, float]]:
        # Example: "I completed the Crossword in 36 seconds!"
        # Or: "I completed the Crossword in 1 minute and 36 seconds!"
        
        minutes = 0
        seconds = 0
        
        match_min = re.search(r'(\d+)\s*minutes?', text)
        if match_min:
            minutes = int(match_min.group(1))
            
        match_sec = re.search(r'(\d+)\s*seconds?', text)
        if match_sec:
            seconds = int(match_sec.group(1))
            
        total_seconds = minutes * 60 + seconds
        
        if total_seconds > 0:
            # We don't have a puzzle ID in the text, so use the message date
            puzzle_id = message_date.strftime("%Y-%m-%d")
            return puzzle_id, float(total_seconds)
            
        return None
