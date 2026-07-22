"""Tier 2: Greenhouse public boards API. One GET returns all jobs for a board token."""
from __future__ import annotations
from .base import client

URL = "https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true"


def fetch_greenhouse(companies: list[dict]) -> list[dict]:
    """companies: list of {name, ats_token, is_quant_target}."""
    out: list[dict] = []
    with client() as c:
        for co in companies:
            token = co["ats_token"]
            try:
                resp = c.get(URL.format(token=token))
                resp.raise_for_status()
                for j in resp.json().get("jobs", []):
                    loc = (j.get("location") or {}).get("name")
                    out.append({
                        "company_name": co["name"],
                        "title": j.get("title", ""),
                        "locations": [loc] if loc else [],
                        "season": None, "year": None,
                        "url": j.get("absolute_url"),
                        "apply_url": j.get("absolute_url"),
                        "posted_at": None,
                        "description": (j.get("content") or "")[:4000],
                        "active": True,
                        "source": "greenhouse",
                        "source_url": j.get("absolute_url"),
                        "_is_quant_target": co.get("is_quant_target", False),
                    })
            except Exception as e:
                print(f"[greenhouse] {co['name']} ({token}) failed: {e}")
    return out
