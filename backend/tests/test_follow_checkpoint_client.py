from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from hashlib import sha256
from http.client import HTTPResponse, RemoteDisconnected
from io import BytesIO

import json

import pytest

from test_ingest_data_writer import ROOT

TOKEN = "A" * 43
HOST = "private.example.invalid"
BASE, TREE, ACCEPTED = "1" * 40, "2" * 40, "3" * 40
DIGEST = "4" * 64
NOW = datetime(2026, 11, 11, 15, tzinfo=timezone.utc)


class WireSocket:
    def __init__(self, raw):
        self.raw = raw

    def makefile(self, mode):
        assert mode == "rb"
        return BytesIO(self.raw)


def wire(body=b"", *, status=200, media="application/json", headers=(), size=True):
    lines = [f"HTTP/1.1 {status} Fixture", f"Content-Type: {media}", "Cache-Control: no-store"]
    if size:
        lines.append(f"Content-Length: {len(body)}")
    lines.extend(f"{name}: {value}" for name, value in headers)
    return ("\r\n".join(lines) + "\r\n\r\n").encode("ascii") + body


class Transport:
    def __init__(self, *replies):
        self.replies = iter(replies)
        self.requests = []
        self.closed = 0

    def connect(self, host, *, port, timeout, context):
        assert (host, port, timeout) == (HOST, 443, 2)
        assert context.check_hostname and context.verify_mode == 2
        return self

    def set_debuglevel(self, level):
        assert level == 0

    def request(self, method, path, *, body, headers):
        self.requests.append((method, path, body, headers))

    def getresponse(self):
        reply = next(self.replies)
        if isinstance(reply, Exception):
            raise reply
        result = HTTPResponse(WireSocket(reply))
        result.begin()
        return result

    def close(self):
        self.closed += 1


@pytest.fixture
def protocol(monkeypatch):
    monkeypatch.syspath_prepend(str(ROOT))
    from scripts import follow_checkpoint_client as client
    from scripts.follow_checkpoint_promotion import FollowCheckpointPromotion
    from scripts.follow_pending_checkpoint import PendingFollowPredecessor

    previous = PendingFollowPredecessor(BASE, TREE, None)
    shared = {
        "covers_after": client._wire(NOW - timedelta(days=1)),
        "index_sha256": DIGEST,
        "public_tree": TREE,
        "rows": [],
        "shard_sha256": {"MA": DIGEST},
        "version": 1,
    }
    pending = client._json(
        shared
        | {
            "candidate_commit": "5" * 40,
            "candidate_tree": "6" * 40,
            "predecessor": vars(previous),
            "prepared_at": client._wire(NOW - timedelta(minutes=1)),
        }
    )
    accepted = client._json(
        shared | {"accepted_commit": ACCEPTED, "accepted_at": client._wire(NOW)}
    )
    change = FollowCheckpointPromotion(
        previous,
        sha256(pending).hexdigest(),
        NOW - timedelta(minutes=1),
        PendingFollowPredecessor(ACCEPTED, TREE, sha256(accepted).hexdigest()),
        NOW,
        NOW + timedelta(seconds=1),
        accepted,
    )

    def open_client(transport, **options):
        settings = {
            "origin": f"https://{HOST}:443",
            "token": TOKEN,
            "max_bytes": 4096,
            "timeout": 2,
        }
        return client.FollowCheckpointClient(**(settings | options), _connection=transport.connect)

    return client, open_client, pending, accepted, change


def frame(accepted, pending, *, state="active", extra=(), payload=None):
    return wire(
        accepted + pending if payload is None else payload,
        media="application/octet-stream",
        headers=(
            ("Follow-State", state),
            ("Follow-Accepted-Bytes", str(len(accepted))),
            ("Follow-Pending-Bytes", str(len(pending))),
            *extra,
        ),
    )


def test_exact_http_frame_and_cas_callback(protocol):
    _, open_client, pending, accepted, change = protocol
    transport = Transport(
        frame(accepted, pending),
        wire(b'{"status":"pending"}'),
        wire(b'{"status":"promoted"}'),
        wire(b'{"status":"already_promoted"}'),
        wire(b'{"status":"stale"}', status=409),
        wire(b'{"status":"rejected"}'),
    )
    client = open_client(transport)
    loaded = client.load()
    assert (loaded.state, loaded.accepted, loaded.pending) == ("active", accepted, pending)
    assert client.stage(pending) == "pending"
    assert client.compare_and_set(change) == "promoted"
    assert client.compare_and_set(change) == "already_promoted"
    assert client.reject(change.pending_generation) is False
    assert client.reject(change.pending_generation) is True
    assert [(method, path, body) for method, path, body, _ in transport.requests] == [
        ("GET", "/v1/checkpoint", None),
        ("POST", "/v1/checkpoint/stage", pending),
        ("POST", "/v1/checkpoint/promote", accepted),
        ("POST", "/v1/checkpoint/promote", accepted),
        ("POST", "/v1/checkpoint/reject", None),
        ("POST", "/v1/checkpoint/reject", None),
    ]
    sent = transport.requests[2][3]
    assert sent["Follow-Predecessor"] == f"{BASE}:{TREE}:-"
    assert sent["Follow-Pending-Generation"] == change.pending_generation
    assert sent["Follow-Checked-At"] == "2026-11-11T15:00:01.000000Z"
    assert sent["Authorization"] == f"Bearer {TOKEN}"
    assert transport.closed == 6


def test_invalid_load_frames_and_canonical_bytes_fail_closed(protocol):
    module, open_client, pending, accepted, _ = protocol
    invalid = (
        frame(accepted, pending, state="expired"),
        frame(accepted, pending, extra=(("Follow-State", "active"),)),
        frame(accepted, pending, extra=(("Content-Length", "1"),)),
        frame(accepted, pending, extra=(("Transfer-Encoding", "chunked"),)),
        frame(accepted, pending, extra=(("Content-Encoding", "gzip"),)),
        frame(accepted, pending, payload=accepted + pending[:-1]),
        frame(accepted, pending, payload=accepted + pending + b" "),
        frame(accepted, pending + b" "),
        frame(accepted, accepted),
        frame(accepted, module._json(json.loads(pending) | {"candidate_commit": "5" * 64})),
        frame(module._json(json.loads(accepted) | {"public_tree": 5}), pending),
        frame(accepted, pending * 8),
    )
    for reply in invalid:
        transport = Transport(reply)
        with pytest.raises(module.FollowCheckpointClientError, match="invalid checkpoint response"):
            open_client(transport).load()
        assert len(transport.requests) == transport.closed == 1


def test_chunked_framing_and_expired_empty_state(protocol):
    _, open_client, _, _, _ = protocol
    transport = Transport(
        wire(
            b"0\r\n\r\n",
            media="application/octet-stream",
            size=False,
            headers=(
                ("Follow-State", "expired"),
                ("Follow-Accepted-Bytes", "0"),
                ("Follow-Pending-Bytes", "0"),
                ("Transfer-Encoding", "chunked"),
            ),
        )
    )
    assert open_client(transport).load().state == "expired"


def test_redirects_uncertain_mutations_and_bad_statuses_never_retry(protocol):
    module, open_client, pending, _, _ = protocol
    replies = (
        wire(status=307, headers=(("Location", "https://elsewhere.invalid/private"),)),
        wire(b'{"status":"pending"}', status=409),
        wire(b'{"status":"promoted"}'),
        wire(b'{"status":"pending","status":"pending"}'),
        wire(b'{"status":"pending"}\n'),
        RemoteDisconnected("private " + TOKEN),
    )
    for reply in replies:
        transport = Transport(reply)
        with pytest.raises(module.FollowCheckpointClientError) as failure:
            open_client(transport).stage(pending)
        assert TOKEN not in str(failure.value)
        assert failure.value.__context__ is None
        assert len(transport.requests) == transport.closed == 1


def test_invalid_configuration_and_promotion_do_not_connect(protocol):
    module, open_client, pending, _, change = protocol
    transport = Transport()
    for origin in (
        "http://private.example.invalid",
        "https://user:secret@private.example.invalid",
        "https://private.example.invalid/v1/checkpoint",
        "https://private.example.invalid?",
        "https://private.example.invalid:0",
        "https://private.example.invalid:",
        "https://private.example.invalid\\malformed",
    ):
        with pytest.raises(module.FollowCheckpointClientError, match="configuration"):
            open_client(transport, origin=origin)
    client = open_client(transport)
    for bad in (replace(change, payload=pending), replace(change, pending_generation="wrong")):
        with pytest.raises(
            module.FollowCheckpointClientError, match="invalid checkpoint promotion"
        ):
            client.compare_and_set(bad)
    with pytest.raises(module.FollowCheckpointClientError, match="invalid pending checkpoint"):
        client.stage(module._json(json.loads(pending) | {"public_tree": 5}))
    assert not transport.requests


def test_elapsed_deadline_after_read_fails_closed(protocol, monkeypatch):
    module, open_client, pending, _, _ = protocol
    samples = iter((0, 1, 2))
    monkeypatch.setattr(module, "monotonic", lambda: next(samples))
    transport = Transport(wire(b'{"status":"pending"}'))
    with pytest.raises(module.FollowCheckpointClientError, match="transport timeout"):
        open_client(transport).stage(pending)
    assert len(transport.requests) == transport.closed == 1
