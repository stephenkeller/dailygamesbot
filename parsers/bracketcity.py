import re
from typing import Optional, Tuple
from datetime import datetime
from parsers.base import GameParser

class BracketCityBase(GameParser):
    @property
    def ascending(self) -> bool:
        return False  # Higher score is better

    def parse(self, text: str, message_date: datetime) -> Optional[Tuple[str, float, Optional[float], Optional[float]]]:
        puzzle_id = None
        score = None
        
        # Look for puzzle date (e.g., "August 21, 2026")
        date_match = re.search(r'\]\s*([A-Za-z]+\s+\d{1,2},\s+\d{4})', text)
        if date_match:
            try:
                # Convert "August 21, 2026" to "2026-08-21"
                dt = datetime.strptime(date_match.group(1), "%B %d, %Y")
                puzzle_id = dt.strftime("%Y-%m-%d")
            except ValueError:
                puzzle_id = date_match.group(1)
        else:
            puzzle_id = message_date.strftime("%Y-%m-%d")
            
        # Look for Total Score (e.g., "Total Score: 63.1")
        score_match = re.search(r'Total Score:\s*([\d\.]+)', text, re.IGNORECASE)
        if score_match:
            score = float(score_match.group(1))
            
        if puzzle_id and score is not None:
            return puzzle_id, score, None, None
            
        return None

class BracketCityParser(BracketCityBase):
    @property
    def game_name(self) -> str:
        return "Bracket City"
        
    def can_parse(self, text: str) -> bool:
        return "[bracket city]" in text.lower() and "hard mode!" not in text.lower()

class BracketCityHardParser(BracketCityBase):
    @property
    def game_name(self) -> str:
        return "Bracket City (Hard Mode)"
        
    def can_parse(self, text: str) -> bool:
        return "[bracket city]" in text.lower() and "hard mode!" in text.lower()
