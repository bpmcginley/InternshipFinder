"""Independent Python canonical-byte checks for the shared Worker codec golden cases."""

from hashlib import sha256
import json
from pathlib import Path

import pytest

FIXTURE = (
    Path(__file__).resolve().parents[2] / "worker/test/fixtures/follow-checkpoint-payload.json"
)
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]
COMMON = {"version", "covers_after", "index_sha256", "shard_sha256", "rows"}


def canonical(value):
    # Original #365/#372 _json spelling, independently exercised against the same JS fixtures.
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_original_python_canonical_split_and_reassembly(case):
    raw = case["checkpoint"].encode("utf-8")
    value = json.loads(raw)
    payload = {key: value[key] for key in COMMON}
    header = {key: item for key, item in value.items() if key not in COMMON}
    assert canonical(value) == raw == canonical(payload | header)
    assert canonical(payload) == case["payload"].encode("utf-8")
    assert canonical(header) == case["header"].encode("utf-8")
    assert sha256(raw).hexdigest() == case["sha256"]
    assert sha256(canonical(payload)).hexdigest() == case["payload_sha256"]
    assert payload["rows"] == sorted(payload["rows"])
    if "closed_id" in case:
        assert len(payload["rows"]) == 2
        assert case["closed_id"] in {row[0] for row in payload["rows"]}


def test_real_pending_and_accepted_share_every_lineage_byte():
    assert CASES[0]["payload"] == CASES[1]["payload"]
    assert CASES[0]["payload_sha256"] == CASES[1]["payload_sha256"]
    assert CASES[0]["header"] != CASES[1]["header"]
