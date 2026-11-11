"""Ordered shared vocabulary and browser display data."""

from __future__ import annotations

import json
from importlib.resources import files

_DATA = json.loads(files(__package__).joinpath("vocabulary.json").read_text(encoding="utf-8"))

US_PLACE_LABELS = tuple(map(tuple, _DATA["us_places"]))
CANADIAN_PROVINCES = tuple(map(tuple, _DATA["canadian_provinces"]))
STAGE_LABELS = tuple(map(tuple, _DATA["stages"]))
YEAR_LABELS = tuple(map(tuple, _DATA["years"]))
FIELD_DISPLAY_OVERRIDES = tuple(map(tuple, _DATA["field_display_overrides"]))
BASELINE_STATES = tuple(_DATA["baseline_states"])
HOME_STATE_CODES = (*BASELINE_STATES, "remote")
