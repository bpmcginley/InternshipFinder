"""Check a few known public listings. No account access, posting or indexing claims.

Run: python growth/directory_monitor.py > directory-status.json
2026-11-04: Keep unparseable or blocked responses unknown. Revert: remove this file and its workflow.
"""

import json
from datetime import datetime, timezone
from html.parser import HTMLParser
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen
from urllib.robotparser import RobotFileParser

SITES = {
    "SaaSHub": "https://www.saashub.com/internscout",
    "Indie Hackers": "https://www.indiehackers.com/product/internscout",
    "Peerlist": "https://peerlist.io/brucepmcginley/project/internscout",
}
AGENT = "InternScoutDirectoryCheck/1.0"


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.hrefs = []
        self.text = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self.hrefs.append(dict(attrs).get("href") or "")

    def handle_data(self, data):
        self.text.append(data)


def get(url):
    with urlopen(Request(url, headers={"User-Agent": AGENT}), timeout=20) as response:
        return (
            response.status,
            response.url,
            response.headers.get_content_type(),
            response.read(2_000_000).decode("utf-8", "replace"),
        )


def inspect(name, url):
    result = {"name": name, "url": url, "status": "unknown", "direct_link": "unknown"}
    try:
        parts = urlparse(url)
        robots_url = f"{parts.scheme}://{parts.netloc}/robots.txt"
        try:
            _, _, _, robots = get(robots_url)
        except HTTPError as exc:
            if exc.code != 404:
                raise
            robots = ""
        rp = RobotFileParser()
        rp.parse(robots.splitlines())
        if not rp.can_fetch(AGENT, url):
            result["reason"] = "robots disallows check"
            return result
        status, final, content_type, body = get(url)
        result.update(http_status=status, final_url=final)
        if content_type != "text/html" or "internscout" not in body.lower():
            result["reason"] = "not a recognizable listing; review manually"
            return result
        parser = Links()
        parser.feed(body)
        result["status"] = "listing recognizable"
        result["direct_link"] = any(
            urlparse(urljoin(final, link)).hostname in ("internscout.org", "www.internscout.org")
            for link in parser.hrefs
        )
        result["note"] = (
            "HTML link detection only; redirects, JavaScript and indexing require manual review."
        )
    except (HTTPError, URLError, TimeoutError, OSError) as exc:
        result["reason"] = f"fetch unavailable: {type(exc).__name__}"
    return result


if __name__ == "__main__":
    print(
        json.dumps(
            {
                "checked_at": datetime.now(timezone.utc).isoformat(),
                "results": [inspect(name, url) for name, url in SITES.items()],
            },
            indent=2,
        )
    )
