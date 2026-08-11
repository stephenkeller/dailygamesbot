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

    def parse(self, text: str, message_date: datetime) -> Optional[Tuple[str, float, Optional[float], Optional[float]]]:
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
            # Check for a manual date in the text like 8/10, 08-10, 8/10/26, 8/10/2026
            date_match = re.search(r'\b(1[0-2]|0?[1-9])[-/](3[01]|[12][0-9]|0?[1-9])(?:[-/](\d{4}|\d{2}))?\b', text)
            if date_match:
                month = int(date_match.group(1))
                day = int(date_match.group(2))
                year_str = date_match.group(3)
                
                if year_str:
                    if len(year_str) == 2:
                        year = 2000 + int(year_str)
                    else:
                        year = int(year_str)
                else:
                    # Default to current year based on message_date
                    year = message_date.year
                    
                puzzle_id = f"{year:04d}-{month:02d}-{day:02d}"
            else:
                # We don't have a puzzle ID in the text, so use the message date
                puzzle_id = message_date.strftime("%Y-%m-%d")
                
            return puzzle_id, float(total_seconds), None, None
            
        return None
