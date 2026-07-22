"""SQLite via SQLAlchemy 2.0."""
from __future__ import annotations
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase
from .config import DB_URL


class Base(DeclarativeBase):
    pass


engine = create_engine(DB_URL, echo=False, future=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


def init_db() -> None:
    from . import models  # noqa: F401  (register mappers)
    Base.metadata.create_all(engine)
