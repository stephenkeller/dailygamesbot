import re
from typing import Optional, Tuple
from datetime import datetime
from parsers.base import GameParser

class CluesBySamParser(GameParser):
    @property
    def game_name(self) -> str:
        return "Clues By Sam"

    @property
    def ascending(self) -> bool:
        return True  # Lower time is better

    @property
    def bucket_by_day(self) -> bool:
        return True

    def can_parse(self, text: str) -> bool:
        return "#CluesBySam" in text

    def parse(self, text: str, message_date: datetime) -> Optional[Tuple[str, float, Optional[float], Optional[float]]]:
        # Format 1: #CluesBySam - Jul 24th 2026 (Tricky) \n Less than 23 minutes
        # Format 2: I solved the daily #CluesBySam, Aug 10th 2026 (Easy), in 03:01
        
        puzzle_id = None
        score = None
        
        # Extract date as puzzle ID
        date_match = re.search(r'#CluesBySam\s*[,\-]\s*(.*?)\s*\(', text)
        if date_match:
            raw_date = date_match.group(1).strip()
            # Clean ordinals like "24th" -> "24"
            clean_date = re.sub(r'(st|nd|rd|th)', '', raw_date)
            try:
                puzzle_id = datetime.strptime(clean_date, "%b %d %Y").strftime("%Y-%m-%d")
            except ValueError:
                puzzle_id = raw_date
        else:
            puzzle_id = message_date.strftime("%Y-%m-%d")
            
        # Extract time
        time_match_1 = re.search(r'Less than (\d+) minutes?', text, re.IGNORECASE)
        time_match_2 = re.search(r'in (\d{1,2}):(\d{2})', text, re.IGNORECASE)
        
        if time_match_1:
            minutes = int(time_match_1.group(1))
            score = float(minutes * 60)
        elif time_match_2:
            minutes = int(time_match_2.group(1))
            seconds = int(time_match_2.group(2))
            score = float(minutes * 60 + seconds)
            
        if puzzle_id and score is not None:
            # Count penalties
            yellow_squares = text.count('🟨')
            yellow_circles = text.count('🟡')
            
            penalty = (yellow_squares * 60.0) + (yellow_circles * 90.0)
            total_score = score + penalty
            
            return puzzle_id, float(total_score), float(score), float(penalty)
            
        return None
