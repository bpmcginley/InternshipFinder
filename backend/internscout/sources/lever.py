"""Tier 2: Lever public postings API."""
from __future__ import annotations
from .base import client

URL = "https://api.lever.co/v0/postings/{token}?mode=json"


def fetch_lever(companies: list[dict]) -> list[dict]:
    out: list[dict] = []
    with client() as c:
        for co in companies:
            token = co["ats_token"]
            try:
                resp = c.get(URL.format(token=token))
                resp.raise_for_status()
                for j in resp.json():
                    cats = j.get("categories") or {}
                    loc = cats.get("location")
                    out.append({
                        "company_name": co["name"],
                        "title": j.get("text", ""),
                        "locations": [loc] if loc else [],
                        "season": None, "year": None,
                        "url": j.get("hostedUrl"),
                        "apply_url": j.get("applyUrl") or j.get("hostedUrl"),
                        "posted_at": (j.get("createdAt") or 0) / 1000 or None,
                        "description": (j.get("descriptionPlain") or "")[:4000],
                        "active": True,
                        "source": "lever",
                        "source_url": j.get("hostedUrl"),
                        "_is_quant_target": co.get("is_quant_target", False),
                    })
            except Exception as e:
                print(f"[lever] {co['name']} ({token}) failed: {e}")
    return out
