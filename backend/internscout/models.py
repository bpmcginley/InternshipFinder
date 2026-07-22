"""ORM models. Mirrors the data model in the plan doc."""
from __future__ import annotations
from datetime import datetime, timezone
from sqlalchemy import String, Integer, Float, Boolean, DateTime, ForeignKey, Text, JSON, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .db import Base


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Company(Base):
    __tablename__ = "company"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255), index=True)
    ats_type: Mapped[str | None] = mapped_column(String(32))          # greenhouse|lever|...
    ats_token: Mapped[str | None] = mapped_column(String(128))
    careers_url: Mapped[str | None] = mapped_column(String(512))
    is_quant_target: Mapped[bool] = mapped_column(Boolean, default=False)
    listings: Mapped[list["Listing"]] = relationship(back_populates="company")


class Listing(Base):
    __tablename__ = "listing"
    id: Mapped[int] = mapped_column(primary_key=True)
    dedupe_key: Mapped[str] = mapped_column(String(400), unique=True, index=True)
    company_id: Mapped[int | None] = mapped_column(ForeignKey("company.id"))
    company: Mapped["Company"] = relationship(back_populates="listings")
    company_name: Mapped[str] = mapped_column(String(255), index=True)
    title: Mapped[str] = mapped_column(String(400))
    description: Mapped[str | None] = mapped_column(Text)
    field_tags: Mapped[list] = mapped_column(JSON, default=list)
    season: Mapped[str | None] = mapped_column(String(16))
    year: Mapped[int | None] = mapped_column(Integer)
    term: Mapped[str | None] = mapped_column(String(32), index=True)   # "Summer 2027"
    employment_type: Mapped[str | None] = mapped_column(String(32), default="internship")
    location_raw: Mapped[str | None] = mapped_column(String(400))
    lat: Mapped[float | None] = mapped_column(Float)
    lng: Mapped[float | None] = mapped_column(Float)
    is_remote: Mapped[bool] = mapped_column(Boolean, default=False)
    within_radius: Mapped[bool] = mapped_column(Boolean, default=False)
    distance_miles: Mapped[float | None] = mapped_column(Float)
    apply_url: Mapped[str | None] = mapped_column(String(1024))
    posted_at: Mapped[datetime | None] = mapped_column(DateTime)
    first_seen: Mapped[datetime] = mapped_column(DateTime, default=_now)
    last_seen: Mapped[datetime] = mapped_column(DateTime, default=_now)
    status: Mapped[str] = mapped_column(String(16), default="open", index=True)  # open|closed
    relevance_score: Mapped[float] = mapped_column(Float, default=0.0, index=True)
    is_new: Mapped[bool] = mapped_column(Boolean, default=True)

    source_links: Mapped[list["SourceLink"]] = relationship(back_populates="listing", cascade="all, delete-orphan")
    application: Mapped["Application"] = relationship(back_populates="listing", uselist=False, cascade="all, delete-orphan")


class SourceLink(Base):
    __tablename__ = "source_link"
    __table_args__ = (UniqueConstraint("listing_id", "source", name="uq_listing_source"),)
    id: Mapped[int] = mapped_column(primary_key=True)
    listing_id: Mapped[int] = mapped_column(ForeignKey("listing.id"))
    listing: Mapped["Listing"] = relationship(back_populates="source_links")
    source: Mapped[str] = mapped_column(String(48))
    source_url: Mapped[str | None] = mapped_column(String(1024))
    seen_at: Mapped[datetime] = mapped_column(DateTime, default=_now)


class Application(Base):
    __tablename__ = "application"
    id: Mapped[int] = mapped_column(primary_key=True)
    listing_id: Mapped[int] = mapped_column(ForeignKey("listing.id"), unique=True)
    listing: Mapped["Listing"] = relationship(back_populates="application")
    state: Mapped[str] = mapped_column(String(24), default="none")  # none|interested|applied|interviewing|rejected|offer
    applied_at: Mapped[datetime | None] = mapped_column(DateTime)
    deadline: Mapped[datetime | None] = mapped_column(DateTime)
    notes: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now)
