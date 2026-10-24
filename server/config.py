"""Server configuration, read only from environment variables (never from code).

Secrets (REDCap token, staff PIN) must come from the environment or a .env file that is
NOT committed to Git (see .env.example and .gitignore).
"""
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Settings:
    # "mock" keeps records in memory (development, no REDCap needed); "redcap" calls the real API
    redcap_mode: str = "mock"
    redcap_api_url: str = ""
    redcap_api_token: str = field(default="", repr=False)  # never printed
    staff_pin: str = field(default="", repr=False)
    questionnaire_path: Path = ROOT / "questionnaire.json"
    # Pseudonym format; must match what the staff screen accepts (e.g. P0012)
    pid_pattern: str = r"^P[0-9]{4,6}$"
    # Origins allowed to call the API (the frontend URL); empty = same origin only
    allowed_origins: tuple = ()
    session_ttl_seconds: int = 2 * 60 * 60  # an iPad session lasts at most 2 hours
    max_pin_attempts: int = 5
    pin_lockout_seconds: int = 5 * 60
    max_body_bytes: int = 64 * 1024

    def validate(self):
        if self.redcap_mode not in ("mock", "redcap"):
            raise ValueError("REDCAP_MODE must be 'mock' or 'redcap'")
        if self.redcap_mode == "redcap":
            if not self.redcap_api_url.startswith("https://"):
                raise ValueError("REDCAP_API_URL must use https://")
            if not re.fullmatch(r"[0-9A-F]{32}", self.redcap_api_token):
                raise ValueError("REDCAP_API_TOKEN missing or not a 32-character REDCap token")
        if len(self.staff_pin) < 6 or not self.staff_pin.isdigit():
            raise ValueError("STAFF_PIN must be at least 6 digits")
        re.compile(self.pid_pattern)
        return self


def load_settings():
    origins = tuple(o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip())
    return Settings(
        redcap_mode=os.environ.get("REDCAP_MODE", "mock"),
        redcap_api_url=os.environ.get("REDCAP_API_URL", ""),
        redcap_api_token=os.environ.get("REDCAP_API_TOKEN", ""),
        staff_pin=os.environ.get("STAFF_PIN", ""),
        questionnaire_path=Path(os.environ.get("QUESTIONNAIRE_PATH", ROOT / "questionnaire.json")),
        pid_pattern=os.environ.get("PID_PATTERN", r"^P[0-9]{4,6}$"),
        allowed_origins=origins,
    ).validate()
