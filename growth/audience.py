"""Which UMass majors InternScout serves well today, from the exported listings.

The audience to promote to is the one the data can serve: a student whose first visit shows three
listings does not come back. This counts, for every undergraduate major, the open roles that fit it
in the Northeast or remote, and nationwide, and sorts the majors into the tiers growth/README.md uses.

Run from the repo root:  python growth/audience.py [docs]
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
from internscout import seo_pages  # noqa: E402

PRIMARY, SECONDARY, THIN = 200, 100, 10


def tiers(site_dir: str):
    d = seo_pages.load(site_dir)
    rows = []
    for m in d["majors"]:
        if m.get("level") not in (None, "undergrad"):
            continue
        tags = set(m.get("tags") or []) - seo_pages.SKIP_FIELDS
        if not tags:        # Undeclared, BDIC: no field of their own, so every listing is theirs to browse
            continue
        fits =[x for x in d["listings"] if set(x.get("field_tags") or []) & tags]
        near = [x for x in fits if x["keys"] & seo_pages.HOME_STATES]
        rows.append({"major": m["name"], "near": len(near), "all": len(fits)})
    return sorted(rows, key=lambda r: -r["near"]), d["generated_at"]


def main():
    rows, when = tiers(sys.argv[1] if len(sys.argv) > 1 else "docs")
    print(f"Data from {when}\n")
    for title, keep in (("Primary: market now", lambda n: n >= PRIMARY),
                        ("Secondary", lambda n: SECONDARY <= n < PRIMARY),
                        ("Serviceable", lambda n: THIN <= n < SECONDARY),
                        ("Not yet: fix the data first", lambda n: n < THIN)):
        group = [r for r in rows if keep(r["near"])]
        print(f"{title} ({len(group)})")
        for r in group:
            print(f"  {r['near']:5d} nearby  {r['all']:6d} nationwide  {r['major']}")
        print()


if __name__ == "__main__":
    main()
