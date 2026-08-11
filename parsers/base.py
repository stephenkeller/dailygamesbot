from abc import ABC, abstractmethod
from typing import Optional, Tuple
from datetime import datetime

class GameParser(ABC):
    @property
    @abstractmethod
    def game_name(self) -> str:
        """Name of the game (e.g., 'Box Office Game')"""
        pass

    @property
    def ascending(self) -> bool:
        """If True, lower scores are better (e.g., time). Default is False (higher is better)."""
        return False
        
    @property
    def bucket_by_day(self) -> bool:
        """If True, leaderboard will be bucketed by day of week (Monday, Tuesday, etc)."""
        return False

    @abstractmethod
    def can_parse(self, text: str) -> bool:
        """Returns True if this parser can handle the given text."""
        pass

    @abstractmethod
    def parse(self, text: str, message_date: datetime) -> Optional[Tuple[str, float, Optional[float], Optional[float]]]:
        """Parses the text and returns a tuple of (puzzle_id, total_score, raw_score, penalty).
           Returns None if the text could not be successfully parsed.
           message_date is provided as a fallback for puzzle_id if the text doesn't contain one.
        """
        pass
