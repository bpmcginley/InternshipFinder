"""Seed registry of employers with VERIFIED public ATS boards (Tier 2).

Every Greenhouse token below was confirmed live (returned jobs) on 2026-07-22.
Verify/extend: open https://boards-api.greenhouse.io/v1/boards/<token>/jobs in a browser.
Quant firms that run their own portals (Citadel, Two Sigma, DE Shaw, Optiver, SIG, DRW,
XTX) are on the QUANT_WATCHLIST for manual follow-up.
"""
from __future__ import annotations

GREENHOUSE = [
    # ---- Quant / trading (verified live) ----
    {"name": "Jane Street", "ats_token": "janestreet", "is_quant_target": True},
    {"name": "IMC Trading", "ats_token": "imc", "is_quant_target": True},
    {"name": "Jump Trading", "ats_token": "jumptrading", "is_quant_target": True},
    {"name": "Akuna Capital", "ats_token": "akunacapital", "is_quant_target": True},
    {"name": "Virtu Financial", "ats_token": "virtu", "is_quant_target": True},
    {"name": "Flow Traders", "ats_token": "flowtraders", "is_quant_target": True},
    {"name": "Old Mission Capital", "ats_token": "oldmissioncapital", "is_quant_target": True},
    {"name": "PDT Partners", "ats_token": "pdtpartners", "is_quant_target": True},
    {"name": "TransMarket Group", "ats_token": "transmarketgroup", "is_quant_target": True},
    {"name": "Vatic Labs", "ats_token": "vaticlabs", "is_quant_target": True},
    {"name": "Walleye Capital", "ats_token": "walleyecapital-external-students", "is_quant_target": True},
    {"name": "Weiss Asset Management", "ats_token": "weissassetmanagement", "is_quant_target": True},

    # ---- Boston-area / tech (verified live) ----
    {"name": "Datadog", "ats_token": "datadog", "is_quant_target": False},
    {"name": "Klaviyo", "ats_token": "klaviyo", "is_quant_target": False},
    {"name": "Toast", "ats_token": "toast", "is_quant_target": False},
    {"name": "CarGurus", "ats_token": "cargurus", "is_quant_target": False},
    {"name": "Formlabs", "ats_token": "formlabs", "is_quant_target": False},
    {"name": "SimpliSafe", "ats_token": "simplisafe", "is_quant_target": False},
    {"name": "Ginkgo Bioworks", "ats_token": "ginkgobioworks", "is_quant_target": False},
    {"name": "Hometap", "ats_token": "hometap", "is_quant_target": False},
    {"name": "The Trade Desk", "ats_token": "thetradedesk", "is_quant_target": False},

    # ---- Large tech (verified live) ----
    {"name": "Stripe", "ats_token": "stripe", "is_quant_target": False},
    {"name": "Databricks", "ats_token": "databricks", "is_quant_target": False},
    {"name": "Cloudflare", "ats_token": "cloudflare", "is_quant_target": False},
]

LEVER = [
    # Most quant/tech firms have moved off Lever's public API; add here only if verified at
    # https://api.lever.co/v0/postings/<token>?mode=json
]

# Tier 4 quant watchlist (own portals; check manually / add adapters later)
QUANT_WATCHLIST = [
    {"name": "Citadel / Citadel Securities", "careers_url": "https://www.citadel.com/careers/students/"},
    {"name": "Hudson River Trading", "careers_url": "https://www.hudsonrivertrading.com/careers/"},
    {"name": "Two Sigma", "careers_url": "https://careers.twosigma.com/careers/Students"},
    {"name": "DE Shaw", "careers_url": "https://www.deshaw.com/careers"},
    {"name": "DRW", "careers_url": "https://drw.com/work-at-drw"},
    {"name": "Optiver", "careers_url": "https://optiver.com/working-at-optiver/career-opportunities/"},
    {"name": "SIG (Susquehanna)", "careers_url": "https://careers.sig.com/"},
    {"name": "XTX Markets", "careers_url": "https://www.xtxmarkets.com/careers/"},
    {"name": "Tower Research", "careers_url": "https://www.tower-research.com/open-positions/"},
    {"name": "Five Rings", "careers_url": "https://www.fiverings.com/careers"},
]
