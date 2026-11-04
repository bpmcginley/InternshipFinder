"""The public checker must not report blocked or unrecognizable pages as missing links."""
import importlib.util
from pathlib import Path
from urllib.error import HTTPError

path = Path(__file__).resolve().parents[2] / "growth" / "directory_monitor.py"
spec = importlib.util.spec_from_file_location("directory_monitor", path)
monitor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(monitor)


def test_detects_real_direct_link(monkeypatch):
    def fake_get(url):
        if url.endswith("robots.txt"):
            return 200, url, "text/plain", "User-agent: *\nAllow: /"
        return 200, url, "text/html", '<p>InternScout</p><a href="https://internscout.org/">Visit</a>'
    monkeypatch.setattr(monitor, "get", fake_get)
    result = monitor.inspect("Example", "https://example.com/product")
    assert result["status"] == "listing recognizable"
    assert result["direct_link"] is True


def test_blocked_page_remains_unknown(monkeypatch):
    def fake_get(url):
        if url.endswith("robots.txt"):
            return 200, url, "text/plain", "User-agent: *\nAllow: /"
        raise HTTPError(url, 403, "Forbidden", {}, None)
    monkeypatch.setattr(monitor, "get", fake_get)
    result = monitor.inspect("Example", "https://example.com/product")
    assert result["status"] == "unknown"
    assert result["direct_link"] == "unknown"


def test_robots_exclusion_is_not_bypassed(monkeypatch):
    def fake_get(url):
        assert url.endswith("robots.txt")
        return 200, url, "text/plain", "User-agent: *\nDisallow: /"
    monkeypatch.setattr(monitor, "get", fake_get)
    assert monitor.inspect("Example", "https://example.com/product")["status"] == "unknown"


def test_login_or_javascript_shell_does_not_claim_listing_missing(monkeypatch):
    def fake_get(url):
        if url.endswith("robots.txt"):
            return 200, url, "text/plain", "User-agent: *\nAllow: /"
        return 200, url, "text/html", "<html>Sign in</html>"
    monkeypatch.setattr(monitor, "get", fake_get)
    result = monitor.inspect("Example", "https://example.com/product")
    assert result["status"] == "unknown"
    assert result["direct_link"] == "unknown"
