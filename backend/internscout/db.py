"""SQLite via SQLAlchemy 2.0."""
from __future__ import annotations
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from .config import DB_URL


class Base(DeclarativeBase):
    pass


engine = create_engine(DB_URL, echo=False, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


def init_db() -> None:
    from . import models  # noqa: F401  (register mappers)
    Base.metadata.create_all(engine)
    # create_all never alters existing tables: add columns introduced later
    have = {c["name"] for c in inspect(engine).get_columns("listing")}
    added = {"state": "VARCHAR(24)", "region_locations": "JSON", "ats": "VARCHAR(24)", "score_parts": "JSON", "stage": "JSON",
             "sector": "VARCHAR(32)"}
    with engine.begin() as conn:
        for name, ddl in added.items():
            if name not in have:
                conn.execute(text(f"ALTER TABLE listing ADD COLUMN {name} {ddl}"))
