"""Seed registry of employers with known public ATS boards (Tier 2).

Tokens are the board slugs used by each ATS. VERIFY/EXTEND these on first run:
open https://boards-api.greenhouse.io/v1/boards/<token>/jobs or
https://api.lever.co/v0/postings/<token>?mode=json in a browser.
Quant firms often use their own portals (Tier 4) and may not appear here.
"""
from __future__ import annotations

GREENHOUSE = [
    {"name": "Stripe", "ats_token": "stripe", "is_quant_target": False},
    {"name": "Databricks", "ats_token": "databricks", "is_quant_target": False},
    {"name": "Cloudflare", "ats_token": "cloudflare", "is_quant_target": False},
    {"name": "DoorDash", "ats_token": "doordash", "is_quant_target": False},
    {"name": "HRT (Hudson River Trading)", "ats_token": "wehiretraders", "is_quant_target": True},
    {"name": "Jane Street", "ats_token": "janestreet", "is_quant_target": True},
    {"name": "Akuna Capital", "ats_token": "akunacapital", "is_quant_target": True},
]

LEVER = [
    {"name": "Palantir", "ats_token": "palantir", "is_quant_target": False},
    {"name": "Voleon", "ats_token": "voleon", "is_quant_target": True},
]

# Tier 4 quant watchlist (portal-based; checked manually or via future adapters)
QUANT_WATCHLIST = [
    {"name": "Citadel / Citadel Securities", "careers_url": "https://www.citadel.com/careers/students/"},
    {"name": "Two Sigma", "careers_url": "https://careers.twosigma.com/careers/Students"},
    {"name": "DE Shaw", "careers_url": "https://www.deshaw.com/careers"},
    {"name": "Jump Trading", "careers_url": "https://www.jumptrading.com/careers/"},
    {"name": "DRW", "careers_url": "https://drw.com/work-at-drw"},
    {"name": "Optiver", "careers_url": "https://optiver.com/working-at-optiver/career-opportunities/"},
    {"name": "SIG (Susquehanna)", "careers_url": "https://careers.sig.com/"},
]
