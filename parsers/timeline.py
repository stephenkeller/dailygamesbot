import re
from typing import Optional, Tuple
from datetime import datetime
from parsers.base import GameParser

class TimelineParser(GameParser):
    @property
    def game_name(self) -> str:
        return "Timeline"

    def can_parse(self, text: str) -> bool:
        return "Timeline 🗓️ #" in text and "Total:" in text

    def parse(self, text: str, message_date: datetime) -> Optional[Tuple[str, float, Optional[float], Optional[float]]]:
        # Example: 
        # Timeline 🗓️ #193
        # Total: 528/600
        
        puzzle_match = re.search(r'Timeline 🗓️ #(\d+)', text)
        score_match = re.search(r'Total:\s*(\d+)/600', text)
        
        if puzzle_match and score_match:
            puzzle_id = puzzle_match.group(1)
            score = float(score_match.group(1))
            if puzzle_id and score is not None:
                return puzzle_id, score, None, None
            
        return None
