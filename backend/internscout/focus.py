"""Point the daily focus searches at whichever fields UMass students are worst served in right now.

The Google Jobs layer holds back a few paid searches a day for the thinnest field. Until this module
that field was chosen by hand ("when another field becomes the thinnest, swap these queries for its
own"), which meant nobody noticed when it changed. Now every run reads the previous export, counts
the open roles in the Northeast and remote for each field a UMass undergraduate major depends on,
and spends the focus searches on the fields with the least per major that needs them. When a field
fills up it drops out on its own, and the next thinnest takes its place.

Only fields with a search bank below are chosen; a field nobody can search for usefully is skipped
rather than spending money on a vague query.
"""
from __future__ import annotations

import os
from collections import Counter

SEARCHES: dict[str, list[str]] = {
    "psychology": ["psychology research assistant internship", "psychology internship undergraduate",
                   "behavioral health internship college student", "mental health internship undergraduate"],
    "nursing": ["nursing student internship", "student nurse extern summer 2027",
                "nurse extern program", "patient care technician student"],
    "health": ["hospital internship undergraduate", "healthcare internship college student",
               "health administration internship", "clinical internship undergraduate"],
    "public_health": ["public health internship undergraduate", "community health internship",
                      "health policy internship", "epidemiology internship undergraduate"],
    "clinical_research": ["clinical research assistant internship", "clinical research intern undergraduate"],
    "arts": ["arts administration internship", "arts nonprofit internship", "gallery internship",
             "creative internship college student"],
    "museums": ["museum internship", "museum education internship", "curatorial internship", "archives internship"],
    "music": ["music industry internship", "orchestra internship", "music nonprofit internship", "record label internship"],
    "theater": ["theater internship", "performing arts internship", "stage management internship", "arts center internship"],
    "film": ["film production internship", "video production internship college student"],
    "languages": ["translation internship", "bilingual internship college student",
                  "international education internship", "language assistant internship"],
    "social_science": ["social science research assistant", "sociology research internship",
                       "survey research internship", "anthropology internship"],
    "education": ["education internship college student", "teaching assistant internship undergraduate",
                  "tutoring internship", "youth program internship"],
    "social_work": ["social work internship undergraduate", "human services internship", "community services internship"],
    "publishing": ["publishing internship", "editorial internship", "book publishing internship"],
    "journalism": ["journalism internship 2027", "newsroom internship", "reporting internship"],
    "library": ["library internship", "archives internship college student"],
    "physics": ["physics research internship undergraduate", "astronomy internship undergraduate"],
    "chemistry": ["chemistry internship undergraduate", "chemistry lab internship"],
    "biology": ["biology internship undergraduate", "biology research internship"],
    "agriculture": ["agriculture internship", "food science internship", "animal science internship", "farm internship"],
    "sports": ["sports management internship", "athletics internship", "sports marketing internship"],
    "hospitality": ["hotel management internship", "event planning internship", "tourism internship"],
    "biomedical": ["biomedical engineering internship", "medical device internship"],
    "economics": ["economics internship undergraduate", "economic research internship"],
    "government": ["government internship college student", "legislative internship"],
    "law": ["legal internship undergraduate", "law firm internship college student"],
    "nonprofit": ["nonprofit internship summer 2027", "nonprofit program internship"],
}

HOME = {"MA", "CT", "RI", "NH", "VT", "ME", "NY", "NJ", "remote"}
FIELDS = 3          # fields focused on at once
ENOUGH = 60         # a field with this many open roles nearby is not thin


def thinnest(listings: list[dict], majors: list[dict], k: int = FIELDS) -> list[tuple[str, int, int]]:
    """(field, open nearby, majors that depend on it) for the k fields to focus on, neediest first.

    Need is the number of undergraduate majors that list the field as one of their own, divided by
    what is open nearby: ten language majors sharing one empty field outrank one major with a few.
    """
    near = Counter(t for x in listings if x["keys"] & HOME for t in set(x.get("field_tags") or []))
    depends = Counter(t for m in majors if m.get("level") in (None, "undergrad") for t in set(m.get("tags") or []))
    candidates = [(t, near.get(t, 0), n) for t, n in depends.items() if t in SEARCHES and near.get(t, 0) < ENOUGH]
    candidates.sort(key=lambda c: (-(c[2] / (c[1] + 1)), c[1], c[0]))
    return candidates[:k]


def interleave(fields: list[str]) -> list[str]:
    """One query from each chosen field in turn, so the daily rotation reaches every field."""
    banks = [SEARCHES[f] for f in fields]
    out = []
    for i in range(max((len(b) for b in banks), default=0)):
        out += [b[i] for b in banks if i < len(b)]
    return out


def choose(export_dir: str | None, fallback: list[str]) -> list[str]:
    """The focus queries for this run, from the last export in export_dir (docs/data), or fallback."""
    if not export_dir or not os.path.exists(os.path.join(export_dir, "listings", "index.json")):
        print("[focus] no previous export; using the configured focus queries")
        return fallback
    try:
        from .seo_pages import load
        # load() reads <site>/data; the export directory is that data folder.
        d = load(os.path.dirname(os.path.abspath(export_dir)))
        picks = thinnest(d["listings"], d["majors"])
    except Exception as e:           # never let targeting break an ingest
        print(f"[focus] could not read the last export ({type(e).__name__}); using the configured focus queries")
        return fallback
    if not picks:
        print("[focus] no field is thin; using the configured focus queries")
        return fallback
    print("[focus] thinnest fields for UMass majors: "
          + ", ".join(f"{t} ({n} open nearby, {m} majors)" for t, n, m in picks))
    return interleave([t for t, _, _ in picks])
