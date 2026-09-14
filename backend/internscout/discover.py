"""ATS auto-discovery: pull job-board tokens out of apply URLs and keep a registry of
boards to scan whole on every run (backend/data/ats_registry.json, committed by CI).

Registry shape: {ats: {token: {"name", "quant", "fails", "added"}}}
Workday tokens are "tenant|wdN|site".
"""
from __future__ import annotations
import json
import os
import re
from datetime import date
from .config import DATA_DIR

REGISTRY_PATH = os.path.join(DATA_DIR, "ats_registry.json")
MAX_FAILS = 4  # consecutive failed runs before a board is dropped

PATTERNS = [
    ("greenhouse", re.compile(r"(?:boards|job-boards)\.greenhouse\.io/(?:embed/job_app\?for=)?([A-Za-z0-9_-]+)", re.I)),
    ("greenhouse", re.compile(r"boards-api\.greenhouse\.io/v1/boards/([A-Za-z0-9_-]+)", re.I)),
    ("lever", re.compile(r"jobs\.lever\.co/([A-Za-z0-9_.-]+)", re.I)),
    ("ashby", re.compile(r"jobs\.ashbyhq\.com/([A-Za-z0-9_.%-]+)", re.I)),
    ("workday", re.compile(r"https?://([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com/(?:[a-z]{2}-[A-Z]{2}/)?([A-Za-z0-9_-]+)", re.I)),
    ("smartrecruiters", re.compile(r"(?:jobs|careers)\.smartrecruiters\.com/([A-Za-z0-9_-]+)", re.I)),
]
_BAD_TOKENS = {"embed", "job", "jobs", "wday", "login", "apply", "search", "v1", "oneclick-ui"}
ATS_HOSTS = [  # recognised even when no token can be extracted
    ("icims", "icims.com"), ("taleo", "taleo.net"), ("oracle", "oraclecloud.com"),
    ("successfactors", "successfactors"), ("jobvite", "jobvite.com"),
    ("workable", "workable.com"), ("bamboohr", "bamboohr.com"), ("adp", "adp.com"),
    ("greenhouse", "gh_jid="),
]


def ats_of(url: str | None) -> tuple[str, str | None]:
    """('greenhouse', 'janestreet') / ('workday', 'tenant|wd5|Site') / ('icims', None) / ('other', None)."""
    if not url:
        return "other", None
    for ats, pat in PATTERNS:
        m = pat.search(url)
        if m:
            token = "|".join(m.groups())
            last = m.groups()[-1]
            if last.lower() in _BAD_TOKENS:
                continue
            if ats == "workday":
                token = f"{m.group(1).lower()}|{m.group(2).lower()}|{m.group(3)}"
            return ats, token
    low = url.lower()
    for ats, needle in ATS_HOSTS:
        if needle in low:
            return ats, None
    return "other", None


def load_registry() -> dict:
    try:
        with open(REGISTRY_PATH, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_registry(reg: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    out = {ats: dict(sorted(boards.items(), key=lambda kv: kv[0].lower())) for ats, boards in sorted(reg.items())}
    with open(REGISTRY_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=1, ensure_ascii=False)


def add_board(reg: dict, ats: str, token: str, name: str, quant: bool = False) -> bool:
    boards = reg.setdefault(ats, {})
    lower = {t.lower(): t for t in boards}
    if token.lower() in lower:
        entry = boards[lower[token.lower()]]
        entry["quant"] = entry.get("quant", False) or quant
        return False
    boards[token] = {"name": name or token, "quant": quant, "fails": 0, "added": date.today().isoformat()}
    return True


def seed_registry(reg: dict) -> int:
    from . import companies_seed as seed
    n = 0
    for ats in ("GREENHOUSE", "LEVER", "ASHBY", "WORKDAY", "SMARTRECRUITERS"):
        for co in getattr(seed, ats, []):
            n += add_board(reg, ats.lower(), co["ats_token"], co["name"], co.get("is_quant_target", False))
    return n


def discover(reg: dict, items: list[dict]) -> int:
    """Register every board seen in the apply URLs of raw items. Returns # of new boards."""
    n = 0
    for it in items:
        for url in {it.get("apply_url"), it.get("url")}:
            ats, token = ats_of(url)
            if token:
                n += add_board(reg, ats, token, it.get("company_name") or "")
    return n


def boards(reg: dict):
    for ats, entries in reg.items():
        for token, entry in entries.items():
            if entry.get("fails", 0) < MAX_FAILS:
                yield ats, token, entry


def record_result(reg: dict, ats: str, token: str, ok: bool) -> None:
    entry = reg.get(ats, {}).get(token)
    if entry is not None:
        entry["fails"] = 0 if ok else entry.get("fails", 0) + 1


def prune(reg: dict) -> int:
    dead = [(a, t) for a, e in reg.items() for t, v in e.items() if v.get("fails", 0) >= MAX_FAILS]
    for a, t in dead:
        del reg[a][t]
    return len(dead)
