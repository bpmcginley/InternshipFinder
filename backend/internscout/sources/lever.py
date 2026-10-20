"""Lever public postings API.

Token: the board slug, e.g. "palantir". A board hosted in Lever's EU region carries the region
after a pipe - "cirrus|eu" - because api.lever.co answers 404 for those and api.eu.lever.co
serves them. Plenty of EU-hosted boards advertise US internships, so they are worth reading.
"""
from __future__ import annotations
from .base import client
from .common import board_item, counts_of, stamp_board_newest
from ..classify import is_internship
from ..region import board_state, place_bare_cities

URL = "https://api.{region}lever.co/v0/postings/{slug}?mode=json"


def url_of(token: str) -> str:
    """'palantir' -> the US API; 'cirrus|eu' -> the EU one."""
    slug, _, region = token.partition("|")
    return URL.format(region=f"{region.lower()}." if region else "", slug=slug)


def parse_lever(payload: list, co: dict) -> list[dict]:
    out, board, counts = [], [], counts_of(co)
    for j in payload or []:
        cats = j.get("categories") or {}
        board.append(cats.get("location"))
        title = j.get("text", "")
        if not is_internship(title, cats.get("commitment") or ""):
            counts.discard("not_student")
            continue
        locs = list(dict.fromkeys([cats.get("location")] + list(cats.get("allLocations") or [])))
        if (j.get("workplaceType") == "remote") and not any("remote" in (l or "").lower() for l in locs):
            country = (j.get("country") or "US").upper()
            # "Remote - CA" read as remote-in-California; Lever's country is the ISO code, and CA is Canada.
            locs.append("Remote" if country == "US" else "Remote - Canada" if country == "CA" else f"Remote - {j.get('country')}")
        created = j.get("createdAt")
        out.append(board_item(co, source="lever", title=title, locations=locs,
                              url=j.get("hostedUrl"), apply_url=j.get("applyUrl") or j.get("hostedUrl"),
                              posted_at=created / 1000 if created else None,
                              description=j.get("descriptionPlain") or "",
                              employment_type=cats.get("commitment") or ""))
    place_bare_cities(out, board_state(board))
    stamp_board_newest(out, [j.get("createdAt") for j in payload or []])   # see normalize._zombie
    return out


def fetch_lever_board(c, co: dict) -> list[dict]:
    resp = c.get(url_of(co["ats_token"]))
    resp.raise_for_status()
    payload = resp.json()
    if not isinstance(payload, list) or not all(isinstance(job, dict) for job in payload):
        raise ValueError("Lever response is missing its complete postings list")
    counts = counts_of(co)
    counts.rows(len(payload))
    counts.reported(len(payload))   # unpaged: the list is everything the board listed
    items = parse_lever(payload, co)
    co["_scan_complete"] = True
    return items


def fetch_lever(companies: list[dict]) -> list[dict]:
    out: list[dict] = []
    with client() as c:
        for co in companies:
            try:
                out += fetch_lever_board(c, co)
            except Exception as e:
                print(f"[lever] {co['name']} ({co['ats_token']}) failed: {e}")
    return out
