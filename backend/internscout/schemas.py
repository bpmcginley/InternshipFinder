from __future__ import annotations
from datetime import datetime
from pydantic import BaseModel


class SourceOut(BaseModel):
    source: str
    source_url: str | None = None


class ListingOut(BaseModel):
    id: int
    company_name: str
    title: str
    field_tags: list[str]
    term: str | None
    location_raw: str | None
    is_remote: bool
    within_radius: bool
    distance_miles: float | None
    apply_url: str | None
    status: str
    relevance_score: float
    is_new: bool
    first_seen: datetime
    last_seen: datetime
    app_state: str = "none"
    sources: list[SourceOut] = []


class AppUpdate(BaseModel):
    state: str | None = None
    notes: str | None = None
    deadline: datetime | None = None
