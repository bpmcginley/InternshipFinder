import subprocess
import sys
from pathlib import Path
from shutil import copyfile

from internscout import classify, focus, geo, near_metros, vocabulary
from internscout.site import source, taxonomy

ROOT = Path(__file__).resolve().parents[2]


def test_vocabulary_projections_keep_order_and_labels():
    assert classify.STAGES == tuple(key for key, _ in vocabulary.STAGE_LABELS)
    assert classify.YEARS == tuple(key for key, _ in vocabulary.YEAR_LABELS)
    assert list(geo.STATE_NAMES.values()) == [
        key for key, _ in vocabulary.US_PLACE_LABELS if key not in {"DC", "PR"}
    ] + ["DC", "PR"]
    assert geo.STATE_NAMES["district of columbia"] == "DC"
    assert dict(vocabulary.US_PLACE_LABELS)["DC"] == "District of Columbia"
    assert taxonomy.US_STATES["DC"] == "Washington, DC"
    assert taxonomy.US_STATES["remote"] == "Remote (US)"
    assert focus.HOME == source.HOME_STATES == set(vocabulary.HOME_STATE_CODES)
    assert focus.HOME is not source.HOME_STATES
    assert list(taxonomy.CA_PROVINCES.items()) == list(vocabulary.CANADIAN_PROVINCES)
    assert list(geo.PROVINCES.items()) == sorted(vocabulary.CANADIAN_PROVINCES)
    assert list(near_metros.FIELD_TAGS.items()) == [
        (field["slug"], tuple(field["tags"])) for field in near_metros.FIELDS
    ]


def test_browser_vocabulary_is_current():
    subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "generate_vocabulary.py"), "--check"],
        check=True,
    )


def test_browser_generator_only_replaces_the_owned_ranges(tmp_path):
    paths = (
        "scripts/generate_vocabulary.py",
        "backend/internscout/vocabulary.json",
        "docs/js/core/profile.mjs",
        "docs/js/buy.js",
    )
    for name in paths:
        target = tmp_path / name
        target.parent.mkdir(parents=True, exist_ok=True)
        copyfile(ROOT / name, target)

    command = [sys.executable, str(tmp_path / paths[0])]
    source = tmp_path / paths[1]
    original = source.read_bytes()
    source.write_bytes(original.replace(b'"Software"', b'"Software; QA"'))
    targets = [tmp_path / name for name in paths[2:]]
    core = targets[0].read_bytes().replace(b"\r\n", b"\n")
    targets[0].write_bytes(core.replace(b"\n", b"\r\n"))
    before = [target.read_bytes() for target in targets]
    assert subprocess.run([*command, "--check"], capture_output=True).returncode == 1
    assert [target.read_bytes() for target in targets] == before

    broken = before[1].replace(b"var FIELD_NAMES", b"var OLD_FIELD_NAMES")
    targets[1].write_bytes(broken)
    assert subprocess.run(command, capture_output=True).returncode == 1
    assert [target.read_bytes() for target in targets] == [before[0], broken]

    malformed = before[1].replace(b'co_op: "Co-op" };', b'co_op: "Co-op" }')
    targets[1].write_bytes(malformed)
    assert subprocess.run(command, capture_output=True).returncode == 1
    assert [target.read_bytes() for target in targets] == [before[0], malformed]

    duplicate = before[1] + b'\n  var FIELD_NAMES = {};\n'
    targets[1].write_bytes(duplicate)
    assert subprocess.run(command, capture_output=True).returncode == 1
    assert [target.read_bytes() for target in targets] == [before[0], duplicate]

    targets[1].write_bytes(before[1])
    subprocess.run(command, check=True)
    assert [target.read_bytes() for target in targets] == [
        item.replace(b'swe: "Software"', b'swe: "Software; QA"') for item in before
    ]
    subprocess.run([*command, "--check"], check=True)
