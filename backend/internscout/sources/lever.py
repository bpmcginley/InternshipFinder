"""Lever public postings API."""
from __future__ import annotations
from .base import client
from .common import board_item
from ..classify import is_internship

URL = "https://api.lever.co/v0/postings/{token}?mode=json"


def parse_lever(payload: list, co: dict) -> list[dict]:
    out = []
    for j in payload or []:
        cats = j.get("categories") or {}
        title = j.get("text", "")
        if not is_internship(title, cats.get("commitment") or ""):
            continue
        locs = list(dict.fromkeys([cats.get("location")] + list(cats.get("allLocations") or [])))
        if (j.get("workplaceType") == "remote") and not any("remote" in (l or "").lower() for l in locs):
            locs.append("Remote" if (j.get("country") or "US").upper() == "US" else f"Remote - {j.get('country')}")
        created = j.get("createdAt")
        out.append(board_item(co, source="lever", title=title, locations=locs,
                              url=j.get("hostedUrl"), apply_url=j.get("applyUrl") or j.get("hostedUrl"),
                              posted_at=created / 1000 if created else None,
                              description=j.get("descriptionPlain") or "",
                              employment_type=cats.get("commitment") or ""))
    return out


def fetch_lever_board(c, co: dict) -> list[dict]:
    resp = c.get(URL.format(token=co["ats_token"]))
    resp.raise_for_status()
    return parse_lever(resp.json(), co)


def fetch_lever(companies: list[dict]) -> list[dict]:
    out: list[dict] = []
    with client() as c:
        for co in companies:
            try:
                out += fetch_lever_board(c, co)
            except Exception as e:
                print(f"[lever] {co['name']} ({co['ats_token']}) failed: {e}")
    return out
