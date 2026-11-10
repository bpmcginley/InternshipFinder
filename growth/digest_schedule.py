"""Choose the GitHub cron that is 8 a.m. in America/New_York on a given Monday.

GitHub Actions schedules are UTC and cannot name a timezone. digest.yml therefore has both the
12:00 and 13:00 UTC Monday slots; exactly one is active as Eastern daylight/standard time changes.
The script writes a GitHub step output and uses only the standard library.
"""
from __future__ import annotations

import sys
from datetime import date, datetime, time, timezone
from zoneinfo import ZoneInfo

EASTERN = ZoneInfo("America/New_York")
CRON_HOURS = {"0 12 * * 1": 12, "0 13 * * 1": 13}


def eastern_eight_utc_hour(day: date) -> int:
    local = datetime.combine(day, time(8), EASTERN)
    return local.astimezone(timezone.utc).hour


def active(schedule: str, day: date) -> bool:
    """Manual runs have no schedule and remain active; scheduled runs must match 8 a.m. Eastern."""
    if not schedule:
        return True
    return CRON_HOURS.get(schedule) == eastern_eight_utc_hour(day)


def main(argv: list[str]) -> int:
    schedule = argv[1].strip() if len(argv) > 1 else ""
    # Both UTC slots occur on Monday, the same calendar day in New York at these hours.
    day = datetime.now(timezone.utc).date()
    print(f"run={'true' if active(schedule, day) else 'false'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
