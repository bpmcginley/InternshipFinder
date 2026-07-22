"""FastAPI app: JSON endpoints + serves the single-file dashboard."""
from __future__ import annotations
import os
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select, func
from .db import SessionLocal, init_db
from .models import Listing, Application, SourceLink
from .schemas import ListingOut, AppUpdate
from .config import PROFILE

app = FastAPI(title="InternScout")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

FRONTEND = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "frontend", "index.html")


@app.on_event("startup")
def _startup():
    init_db()


def _to_out(row: Listing) -> ListingOut:
    return ListingOut(
        id=row.id, company_name=row.company_name, title=row.title,
        field_tags=row.field_tags or [], term=row.term, location_raw=row.location_raw,
        is_remote=row.is_remote, within_radius=row.within_radius,
        distance_miles=row.distance_miles, apply_url=row.apply_url, status=row.status,
        relevance_score=row.relevance_score, is_new=row.is_new,
        first_seen=row.first_seen, last_seen=row.last_seen,
        app_state=row.application.state if row.application else "none",
        sources=[{"source": s.source, "source_url": s.source_url} for s in row.source_links],
    )


@app.get("/api/profile")
def get_profile():
    return {
        "name": PROFILE.name, "fields": PROFILE.fields, "core_fields": PROFILE.core_fields,
        "terms": [f"{s} {y}" for s, y in PROFILE.terms],
        "center_city": PROFILE.center_city, "radius_miles": PROFILE.radius_miles,
        "include_remote": PROFILE.include_remote,
    }


@app.get("/api/stats")
def stats():
    with SessionLocal() as db:
        total = db.scalar(select(func.count()).select_from(Listing))
        open_ = db.scalar(select(func.count()).where(Listing.status == "open"))
        new = db.scalar(select(func.count()).where(Listing.is_new == True))  # noqa: E712
        applied = db.scalar(select(func.count()).select_from(Application).where(Application.state == "applied"))
        return {"total": total or 0, "open": open_ or 0, "new": new or 0, "applied": applied or 0}


@app.get("/api/listings", response_model=list[ListingOut])
def listings(
    q: str | None = None,
    field: str | None = None,
    location: str | None = Query(None, description="in_city|radius|remote"),
    status: str | None = None,
    app_state: str | None = None,
    source: str | None = None,
    new_only: bool = False,
    sort: str = "score",
    limit: int = 500,
):
    with SessionLocal() as db:
        stmt = select(Listing)
        if q:
            like = f"%{q.lower()}%"
            stmt = stmt.where(func.lower(Listing.company_name).like(like) | func.lower(Listing.title).like(like))
        if field:
            stmt = stmt.where(Listing.field_tags.like(f'%"{field}"%'))
        if status:
            stmt = stmt.where(Listing.status == status)
        if new_only:
            stmt = stmt.where(Listing.is_new == True)  # noqa: E712
        if location == "remote":
            stmt = stmt.where(Listing.is_remote == True)  # noqa: E712
        elif location == "radius":
            stmt = stmt.where(Listing.within_radius == True)  # noqa: E712
        elif location == "in_city":
            stmt = stmt.where(func.lower(Listing.location_raw).like("%boston%") |
                              func.lower(Listing.location_raw).like("%cambridge%"))
        if sort == "score":
            stmt = stmt.order_by(Listing.relevance_score.desc(), Listing.first_seen.desc())
        elif sort == "new":
            stmt = stmt.order_by(Listing.first_seen.desc())
        elif sort == "company":
            stmt = stmt.order_by(func.lower(Listing.company_name))
        stmt = stmt.limit(limit)
        rows = db.scalars(stmt).all()
        out = []
        for r in rows:
            if source and source not in {s.source for s in r.source_links}:
                continue
            if app_state and (r.application.state if r.application else "none") != app_state:
                continue
            out.append(_to_out(r))
        return out


@app.get("/api/listings/{lid}", response_model=ListingOut)
def listing_detail(lid: int):
    with SessionLocal() as db:
        row = db.get(Listing, lid)
        if not row:
            raise HTTPException(404)
        row.is_new = False
        db.commit()
        return _to_out(row)


@app.put("/api/listings/{lid}/application", response_model=ListingOut)
def update_application(lid: int, body: AppUpdate):
    with SessionLocal() as db:
        row = db.get(Listing, lid)
        if not row:
            raise HTTPException(404)
        appn = row.application or Application(listing_id=lid)
        if body.state is not None:
            appn.state = body.state
            if body.state == "applied" and not appn.applied_at:
                appn.applied_at = datetime.now(timezone.utc)
        if body.notes is not None:
            appn.notes = body.notes
        if body.deadline is not None:
            appn.deadline = body.deadline
        db.add(appn)
        db.commit()
        db.refresh(row)
        return _to_out(row)


@app.get("/")
def index():
    if os.path.exists(FRONTEND):
        return FileResponse(FRONTEND)
    return {"ok": True, "hint": "frontend/index.html not found"}
