"""Coverage report: open listings per field cluster in the baseline states (plus US-remote).
A thin cluster tells us where to add employer seeds or search queries next.

  python -m internscout.coverage [docs/data/listings] [--min 15] [--all-states]

In GitHub Actions the table is also appended to the job summary.
"""
from __future__ import annotations
import argparse
import collections
import json
import os
from .config import BASELINE_STATES

CLUSTERS = {
    "Health": ("health", "nursing", "public_health", "clinical_research", "biomedical"),
    "Education": ("education", "library"),
    "Government & law": ("government", "law", "urban_planning"),
    "Nonprofit & social work": ("nonprofit", "social_work"),
    "Arts & museums": ("arts", "museums", "theater", "music", "film", "design", "architecture"),
    "Media & communications": ("media", "journalism", "publishing", "communications"),
    "Hospitality & sports": ("hospitality", "sports"),
    "Business": ("finance", "accounting", "consulting", "marketing", "sales", "hr", "operations",
                 "supply_chain", "entrepreneurship", "pm", "real_estate", "insurance", "retail"),
    "Engineering": ("mechanical", "electrical", "civil", "chemical", "industrial", "aerospace",
                    "hardware", "materials", "environmental"),
    "Sciences": ("biology", "chemistry", "physics", "lab_research", "math", "agriculture", "sustainability"),
    "Social sciences": ("psychology", "economics", "languages"),
    "Tech & data": ("swe", "ml", "data", "security", "quant"),
}


def in_baseline(listing: dict) -> bool:
    for g in listing.get("regions") or []:
        if g["state"] in BASELINE_STATES or g["kind"] == "remote":
            return True
    return listing.get("state") in BASELINE_STATES


def open_here(listings: list[dict], baseline_only: bool = True) -> list[dict]:
    return [x for x in listings
            if x.get("status") == "open" and (in_baseline(x) if baseline_only else True)]


def counts(listings: list[dict], baseline_only: bool = True) -> dict[str, int]:
    live = open_here(listings, baseline_only)
    return {name: sum(1 for x in live if set(x.get("field_tags") or ()) & set(tags))
            for name, tags in CLUSTERS.items()}


def per_tag(listings: list[dict], baseline_only: bool = True) -> collections.Counter:
    """Listings per field tag. A cluster count says a gap exists; this says what to seed for."""
    return collections.Counter(t for x in open_here(listings, baseline_only)
                               for t in x.get("field_tags") or ())


def report(listings: list[dict], minimum: int = 15, baseline_only: bool = True) -> str:
    rows = sorted(counts(listings, baseline_only).items(), key=lambda kv: kv[1])
    where = "baseline + remote" if baseline_only else "whole US"
    lines = [f"| Field cluster | Open ({where}) | |", "|---|---:|---|"]
    lines += [f"| {n} | {c} | {'**thin**' if c < minimum else ''} |" for n, c in rows]
    thin = [n for n, c in rows if c < minimum]
    lines.append("")
    if not thin:
        lines.append(f"Every cluster has at least {minimum}.")
        return "\n".join(lines)
    lines.append(f"Thin (< {minimum}): {', '.join(thin)}")
    # Which tags are empty is the part that can be acted on: "Health 12" is not an instruction,
    # "nursing 0" is an employer to go and seed. Rarest first, because that is the order to work in.
    tags = per_tag(listings, baseline_only)
    lines.append("")
    lines.append("Tags inside them, rarest first:")
    for name in thin:
        inside = sorted(CLUSTERS[name], key=lambda t: tags[t])
        lines.append(f"  - {name}: " + ", ".join(f"{t} {tags[t]}" for t in inside))
    return "\n".join(lines)


def load(path: str) -> list[dict]:
    """A folder of per-state files (a listing in several states is counted once) or one JSON array."""
    if not os.path.isdir(path):
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    by_id = {}
    for name in sorted(os.listdir(path)):
        if name.endswith(".json") and name != "index.json":
            with open(os.path.join(path, name), encoding="utf-8") as f:
                by_id.update((x["id"], x) for x in json.load(f))
    return list(by_id.values())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("path", nargs="?", default=os.path.join("docs", "data", "listings"))
    ap.add_argument("--min", type=int, default=15)
    # Worth running both ways when something is thin: thin here but healthy nationally is a New
    # England employer to seed, thin both ways is a classifier rule or a whole source missing.
    ap.add_argument("--all-states", action="store_true",
                    help="count the whole country instead of the baseline states")
    args = ap.parse_args()
    text = report(load(args.path), args.min, not args.all_states)
    print(text)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as f:
            f.write("## Listing coverage\n\n" + text + "\n")


if __name__ == "__main__":
    main()
