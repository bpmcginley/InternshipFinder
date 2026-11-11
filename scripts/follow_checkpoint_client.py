"""Bounded client for the dormant private follow checkpoint HTTPS protocol."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
from http.client import HTTPException, HTTPSConnection
from ipaddress import IPv6Address
import re
import ssl
from time import monotonic
from urllib.parse import urlsplit

from internscout.follow_snapshot_source import _DIGEST, _SHARD, _parse_time, _read
from scripts.follow_checkpoint_promotion import FollowCheckpointPromotion, StorePromotionStatus
from scripts.follow_lineage_checkpoint import _FIELDS as _ACCEPTED
from scripts.follow_lineage_checkpoint import _coverage, _decode_lineage, _instant, _json, _wire
from scripts.follow_pending_checkpoint import _FIELDS as _PENDING
from scripts.follow_pending_checkpoint import PendingFollowPredecessor, _check_predecessor

_PREFIX = "/v1/checkpoint"
_BINARY = "application/octet-stream"
_JSON = "application/json"
_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}")
_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
_LENGTH = re.compile(r"0|[1-9][0-9]{0,15}")
_MAX_BYTES = 8_000_000


class FollowCheckpointClientError(RuntimeError):
    """Checkpoint state is unavailable or an operation's outcome is uncertain."""


@dataclass(frozen=True)
class FollowCheckpointLoad:
    state: str
    accepted: bytes | None
    pending: bytes | None


def _origin(value):
    if (
        not isinstance(value, str)
        or not value.isascii()
        or any(ord(char) <= 32 or char in r"\?#%" for char in value)
    ):
        return None
    try:
        url = urlsplit(value)
        host, port = url.hostname, url.port
        if (
            url.scheme != "https"
            or not host
            or url.username is not None
            or url.path not in ("", "/")
        ):
            return None
        if ":" in host:
            IPv6Address(host)
            authority = f"[{host}]"
        elif len(host) <= 253 and all(_LABEL.fullmatch(label) for label in host.split(".")):
            authority = host
        else:
            return None
        if port is not None:
            if port == 0:
                return None
            authority += f":{port}"
        return (host, port) if authority == url.netloc.lower() else None
    except ValueError:
        return None


def _invalid():
    return FollowCheckpointClientError("invalid checkpoint response")


def _header(response, name):
    values = [value for key, value in response.getheaders() if key.lower() == name.lower()]
    if len(values) > 1:
        raise _invalid()
    return values[0] if values else None


def _length(value, limit):
    if not isinstance(value, str) or not _LENGTH.fullmatch(value) or int(value) > limit:
        raise _invalid()
    return int(value)


def _frame(response, limit):
    if (
        _header(response, "Cache-Control") != "no-store"
        or _header(response, "Content-Encoding") is not None
    ):
        raise _invalid()
    length = _header(response, "Content-Length")
    transfer = _header(response, "Transfer-Encoding")
    if transfer is not None and (transfer.lower() != "chunked" or length is not None):
        raise _invalid()
    return None if length is None else _length(length, limit)


def _body(response, limit, deadline):
    data = bytearray()
    while True:
        if monotonic() >= deadline:
            raise FollowCheckpointClientError("checkpoint transport timeout")
        chunk = response.read1(min(65_536, limit - len(data) + 1))
        if monotonic() >= deadline:
            raise FollowCheckpointClientError("checkpoint transport timeout")
        if not isinstance(chunk, bytes) or len(chunk) > limit - len(data):
            raise _invalid()
        if not chunk:
            return bytes(data)
        data.extend(chunk)


def _matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _record(raw, fields, limit):
    if not isinstance(raw, bytes) or not 0 < len(raw) <= limit:
        return None
    try:
        value = _read(raw)
        if (
            not isinstance(value, dict)
            or value.keys() != fields
            or type(value["version"]) is not int
            or value["version"] != 1
            or not _matches(_DIGEST, value["index_sha256"])
            or not isinstance(value["rows"], list)
            or not isinstance(value["shard_sha256"], dict)
            or not value["shard_sha256"]
            or any(
                not _matches(_SHARD, key) or not _matches(_DIGEST, digest)
                for key, digest in value["shard_sha256"].items()
            )
        ):
            return None
        if fields == _PENDING:
            predecessor = value["predecessor"]
            if not isinstance(predecessor, dict) or predecessor.keys() != {
                "commit",
                "public_tree",
                "checkpoint_sha256",
            }:
                return None
            previous = PendingFollowPredecessor(**predecessor)
            candidate = value["candidate_commit"]
            _check_predecessor(previous)
            _check_predecessor(PendingFollowPredecessor(candidate, value["candidate_tree"], None))
            _check_predecessor(PendingFollowPredecessor(candidate, value["public_tree"], None))
            if len(candidate) != len(previous.commit):
                return None
            at = _instant(value["prepared_at"])
        else:
            _check_predecessor(
                PendingFollowPredecessor(value["accepted_commit"], value["public_tree"], None)
            )
            at = _instant(value["accepted_at"])
        lower = _instant(value["covers_after"])
        _coverage(at, lower, at)
        for (_, raw_time), proof in _decode_lineage(value["rows"]).items():
            _parse_time(raw_time)
            if (proof.observed_by is not None and proof.observed_by > lower) or (
                proof.verified_utc is not None and proof.verified_utc > at
            ):
                return None
        return value if _json(value) == raw else None
    except (ValueError, RecursionError):
        return None


class FollowCheckpointClient:
    """Operator-configured direct HTTPS client. No automatic retry or redirect."""

    def __init__(self, origin, token, *, max_bytes, timeout, _connection=HTTPSConnection):
        target = _origin(origin)
        if (
            target is None
            or not isinstance(token, str)
            or not _TOKEN.fullmatch(token)
            or type(max_bytes) is not int
            or not 0 < max_bytes <= _MAX_BYTES
            or type(timeout) not in (int, float)
            or not 0 < timeout < float('inf')
        ):
            raise FollowCheckpointClientError("invalid checkpoint client configuration")
        self._host, self._port = target
        self._authorization = "Bearer " + token
        self._max_bytes = max_bytes
        self._timeout = timeout
        self._connection = _connection
        self._context = ssl.create_default_context()

    def _request(self, method, suffix, statuses, consume, *, body=None, extra=None):
        connection = response = None
        deadline = monotonic() + self._timeout
        headers = {
            "Authorization": self._authorization,
            "Accept-Encoding": "identity",
            "Connection": "close",
            **(extra or {}),
        }
        if body is not None:
            headers["Content-Type"] = _BINARY
        try:
            connection = self._connection(
                self._host, port=self._port, timeout=self._timeout, context=self._context
            )
            connection.set_debuglevel(0)
            connection.request(method, _PREFIX + suffix, body=body, headers=headers)
            response = connection.getresponse()
            if response.status not in statuses:
                raise FollowCheckpointClientError("checkpoint request refused or unavailable")
            return consume(response, deadline)
        except (OSError, HTTPException, ValueError, OverflowError):
            pass
        finally:
            for resource in (response, connection):
                if resource is not None:
                    try:
                        resource.close()
                    except (OSError, HTTPException):
                        pass
        raise FollowCheckpointClientError("checkpoint transport outcome uncertain")

    def load(self) -> FollowCheckpointLoad:
        def consume(response, deadline):
            if _header(response, "Content-Type") != _BINARY:
                raise _invalid()
            state = _header(response, "Follow-State")
            accepted_size = _length(_header(response, "Follow-Accepted-Bytes"), self._max_bytes)
            pending_size = _length(_header(response, "Follow-Pending-Bytes"), self._max_bytes)
            if state not in ("active", "expired", "never_seeded", "unavailable") or (
                (state == "active") != bool(accepted_size)
            ):
                raise _invalid()
            size = accepted_size + pending_size
            declared = _frame(response, size)
            raw = _body(response, size, deadline)
            if len(raw) != size or (declared is not None and declared != size):
                raise _invalid()
            accepted, pending = raw[:accepted_size], raw[accepted_size:]
            if (accepted and _record(accepted, _ACCEPTED, self._max_bytes) is None) or (
                pending and _record(pending, _PENDING, self._max_bytes) is None
            ):
                raise _invalid()
            return FollowCheckpointLoad(state, accepted or None, pending or None)

        return self._request("GET", "", (200,), consume)

    def _mutate(self, suffix, outcomes, *, body=None, headers=None):
        def consume(response, deadline):
            if _header(response, "Content-Type") != _JSON:
                raise _invalid()
            allowed = outcomes if response.status == 200 else ("stale",)
            expected = {_json({"status": result}): result for result in allowed}
            limit = max(map(len, expected))
            declared = _frame(response, limit)
            raw = _body(response, limit, deadline)
            if raw not in expected or (declared is not None and declared != len(raw)):
                raise _invalid()
            return expected[raw]

        return self._request("POST", suffix, (200, 409), consume, body=body, extra=headers)

    def stage(self, raw: bytes):
        if _record(raw, _PENDING, self._max_bytes) is None:
            raise FollowCheckpointClientError("invalid pending checkpoint")
        return self._mutate("/stage", ("pending", "already_pending"), body=raw)

    def compare_and_set(self, change: FollowCheckpointPromotion) -> StorePromotionStatus:
        if not isinstance(change, FollowCheckpointPromotion):
            raise FollowCheckpointClientError("invalid checkpoint promotion")
        try:
            previous = change.predecessor
            _check_predecessor(previous)
            _check_predecessor(change.accepted)
            checked = _wire(change.checked_at)
            accepted_at = _wire(change.accepted_at)
        except ValueError:
            checked = None
        raw = change.payload
        record = _record(raw, _ACCEPTED, self._max_bytes)
        if (
            checked is None
            or record is None
            or not isinstance(change.pending_generation, str)
            or not _DIGEST.fullmatch(change.pending_generation)
            or change.accepted.checkpoint_sha256 != sha256(raw).hexdigest()
            or record["accepted_commit"] != change.accepted.commit
            or record["public_tree"] != change.accepted.public_tree
            or record["accepted_at"] != accepted_at
        ):
            raise FollowCheckpointClientError("invalid checkpoint promotion")
        return self._mutate(
            "/promote",
            ("promoted", "already_promoted"),
            body=raw,
            headers={
                "Follow-Pending-Generation": change.pending_generation,
                "Follow-Checked-At": checked,
                "Follow-Predecessor": f"{previous.commit}:{previous.public_tree}:{previous.checkpoint_sha256 or '-'}",
            },
        )

    def reject(self, generation: str) -> bool:
        if not isinstance(generation, str) or not _DIGEST.fullmatch(generation):
            raise FollowCheckpointClientError("invalid pending generation")
        return (
            self._mutate(
                "/reject", ("rejected",), headers={"Follow-Pending-Generation": generation}
            )
            == "rejected"
        )
