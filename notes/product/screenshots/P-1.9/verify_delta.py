"""Prove only employer entry markup and page hashes differ from an extracted parent archive."""

import re
import sys
import tarfile
from pathlib import Path

repo = Path(__file__).resolve().parents[4]
baseline = Path(sys.argv[1])
offer = re.compile(r'<section class="prose employer-offer">.*?</section>', re.S)
paid = (
    '<p>Promote an eligible open role in a clearly labeled paid listing. '
    'One role costs $29 for 30 days. Payment never changes organic search rankings.</p>'
)
changed = []
with tarfile.open(repo / "backend/tests/fixtures/golden/expected.tar.gz") as archive:
    for item in archive:
        before = (baseline / item.name).read_bytes()
        after = archive.extractfile(item).read()
        if before == after:
            continue
        changed.append(item.name)
        if item.name == "data/page-content-dates.json":
            continue
        assert item.name.startswith("internships/at/") and item.name.endswith(".html")
        old, new = before.decode("utf-8"), after.decode("utf-8")
        old_offer, new_offer = offer.findall(old), offer.findall(new)
        assert len(old_offer) == len(new_offer) == 1
        assert paid in old_offer[0] and paid in new_offer[0]
        for html in [old_offer[0], new_offer[0]]:
            assert html.count('data-employer-entry="employer"') == 1
        assert re.findall(r'href="([^"]+)"', old_offer[0]) == re.findall(
            r'href="([^"]+)"', new_offer[0]
        )
        assert new.replace(new_offer[0], old_offer[0], 1).encode("utf-8") == before
assert len(changed) == 9
print(
    "Only eight employer entry sections and page hashes changed; paid paragraph and all destinations identical"
)
