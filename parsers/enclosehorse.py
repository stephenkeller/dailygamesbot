import re
from typing import Optional, Tuple
from datetime import datetime
from parsers.base import GameParser

class EncloseHorseParser(GameParser):
    @property
    def game_name(self) -> str:
        return "Enclose.Horse"

    @property
    def ascending(self) -> bool:
        return False  # Higher percentage is better

    def can_parse(self, text: str) -> bool:
        return "enclose.horse" in text.lower() and "%" in text

    def parse(self, text: str, message_date: datetime) -> Optional[Tuple[str, float, Optional[float], Optional[float]]]:
        puzzle_id = None
        score = None
        
        # Look for puzzle ID (e.g., "Day 226")
        day_match = re.search(r'Day\s*(\d+)', text, re.IGNORECASE)
        if day_match:
            puzzle_id = f"Day {day_match.group(1)}"
        else:
            puzzle_id = message_date.strftime("%Y-%m-%d")
            
        # Look for score (e.g., "100%")
        score_match = re.search(r'(\d+(?:\.\d+)?)%', text)
        if score_match:
            score = float(score_match.group(1))
            
        if puzzle_id and score is not None:
            return puzzle_id, score, None, None
            
        return None
