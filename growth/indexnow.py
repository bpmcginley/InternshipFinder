"""Tell search engines which landing pages a deploy added, removed or changed.

IndexNow is read by Bing (which also answers DuckDuckGo, Yahoo and ChatGPT search), Yandex, Seznam
and Naver: a page sent here is recrawled within hours instead of whenever a crawler next passes.
Google does not take IndexNow; it reads sitemap.xml.

The pages workflow saves the sitemap that was live before the deploy, and after the deploy this
compares it with the new one. A URL is sent when it is new, when it is gone (so the engine drops
it), or when its lastmod moved.

Run from the repo root:  python growth/indexnow.py OLD_SITEMAP NEW_SITEMAP [--submit]
Without --submit it only prints what it would send.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

HOST = "internscout.org"
# Public by design: the engines fetch https://internscout.org/<KEY>.txt (docs/<KEY>.txt) and send
# only if it holds this same text, which is what shows the pages are ours to submit.
KEY = "internscout-org-indexnow"
ENDPOINT = "https://api.indexnow.org/indexnow"
BATCH = 10_000                  # the protocol's limit per request
NS = "{http://www.sitemaps.org/schemas/sitemap/0.9}"


def entries(path: str) -> dict[str, str]:
    """url -> lastmod from a sitemap file; empty when the file is missing or not a sitemap."""
    try:
        root = ET.parse(path).getroot()
    except (OSError, ET.ParseError):
        return {}
    out = {}
    for u in root.iter(f"{NS}url"):
        loc = (u.findtext(f"{NS}loc") or "").strip()
        if loc.startswith(f"https://{HOST}/"):
            out[loc] = (u.findtext(f"{NS}lastmod") or "").strip()
    return out


def changed(old: dict[str, str], new: dict[str, str]) -> list[str]:
    return sorted(set(old) ^ set(new) | {u for u in new if u in old and new[u] != old[u]})


def submit(urls: list[str]) -> list[int]:
    statuses = []
    for i in range(0, len(urls), BATCH):
        body = {"host": HOST, "key": KEY, "keyLocation": f"https://{HOST}/{KEY}.txt",
                "urlList": urls[i:i + BATCH]}
        req = urllib.request.Request(ENDPOINT, data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json; charset=utf-8"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                statuses.append(r.status)
        except urllib.error.HTTPError as e:
            statuses.append(e.code)
        except (urllib.error.URLError, TimeoutError):
            statuses.append(0)
    return statuses


def main(argv: list[str]) -> int:
    args = [a for a in argv[1:] if not a.startswith("--")]
    if len(args) != 2:
        print(__doc__)
        return 2
    old, new = entries(args[0]), entries(args[1])
    if not new:
        print(f"[indexnow] {args[1]} has no URLs; nothing sent")
        return 0
    urls = changed(old, new)
    added = sum(1 for u in urls if u not in old)
    gone = sum(1 for u in urls if u not in new)
    print(f"[indexnow] {len(urls)} changed: {added} new, {gone} removed, {len(urls) - added - gone} updated")
    if urls and "--submit" in argv:
        # 200 and 202 are accepted. A failure is reported, never raised: the deploy already happened.
        print(f"[indexnow] submitted, HTTP {submit(urls)}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
