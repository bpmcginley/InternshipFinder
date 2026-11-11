"""Draft source-backed title-discovery sheets from the existing public listing export.

Run: python growth/title_discovery.py docs --out=title-discovery
Writes three 4:5 PNGs, captions and exact source evidence. Makes no network calls,
publishes nothing and never infers degree eligibility from a field tag.

2026-11-02: was: campaign packs offered only a rotating tip and a real search.
Revert: remove this module, its tests and the supplemental campaign workflow step.
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "backend"))
from internscout.site import assets as site_assets  # noqa: E402
from internscout.site import source as site_source  # noqa: E402
from internscout.site import taxonomy as site_taxonomy  # noqa: E402
from internscout.console_log import console  # noqa: E402

# These are topic tags, not majors or employer eligibility requirements.
FIELDS = (
    "finance",
    "marketing",
    "operations",
    "accounting",
    "supply_chain",
    "government",
    "environmental",
    "hr",
    "mechanical",
    "industrial",
)
STATES = ("CT", "MA", "ME", "NH", "NJ", "NY", "RI", "VT", "remote")
MAX_AGE = timedelta(hours=48)
FUTURE_TOLERANCE = timedelta(minutes=5)
MIN_ROLES = 30
TITLES_PER_SHEET = 4
SHEET_COUNT = 3
ELIGIBILITY_NOTE = (
    "Field tags are search categories, not degree eligibility. Check each employer's requirements."
)
SNAPSHOT_NOTE = "Listed open in this snapshot; availability can change."
AGGREGATOR_HOSTS = {
    "jooble.org",
    "indeed.com",
    "glassdoor.com",
    "ziprecruiter.com",
    "simplyhired.com",
    "talent.com",
}
CHANNELS = ("tiktok", "instagram", "facebook", "youtube")
GRADUATE_TITLE = re.compile(r"\b(?:pharmd|ph\.?d\.?|doctoral|m\.?b\.?a\.?)\b", re.I)
MARKETING_EXAMPLE = re.compile(
    r"\b(?:marketing|advertising|brand(?:ing)?|communications?|social\s+media|content)\b", re.I
)


def source_url(value: object) -> str | None:
    """Accept public HTTPS links only; no credentials, local hosts or secret query keys.

    This is a syntax check, not a claim that an employer page was visited or is live.
    No URL is requested by this generator.
    """
    if not isinstance(value, str) or len(value) > 4096:
        return None
    value = value.strip()
    if not value or re.search(r"[\s\\\x00-\x1f\x7f]", value):
        return None
    try:
        p = urlsplit(value)
        host = (p.hostname or "").lower().rstrip(".")
        if (
            p.scheme != "https"
            or p.username is not None
            or p.password is not None
            or p.port not in (None, 443)
        ):
            return None
        if (
            not host
            or "." not in host
            or host.endswith((".local", ".localhost", ".internal", ".invalid", ".test"))
        ):
            return None
        if any(host == blocked or host.endswith("." + blocked) for blocked in AGGREGATOR_HOSTS):
            return None
        try:
            if not ipaddress.ip_address(host).is_global:
                return None
        except ValueError:
            if not re.fullmatch(r"[a-z0-9.-]+", host) or not re.search(r"[a-z]", host):
                return None
        for key, _ in parse_qsl(p.query, keep_blank_values=True):
            if re.search(r"token|password|secret|authorization|api.?key", key, re.I):
                return None
    except ValueError:
        return None
    return value


def url_key(url: str) -> str:
    """Ignore only known advertising tags and fragments when finding duplicate links."""
    p = urlsplit(url)
    query = sorted(
        (k, v)
        for k, v in parse_qsl(p.query, keep_blank_values=True)
        if not k.lower().startswith("utm_") and k.lower() not in {"gclid", "fbclid"}
    )
    return urlunsplit(
        (p.scheme, p.netloc.lower().removesuffix(":443"), p.path.rstrip("/"), urlencode(query), "")
    )


def _text(value: object) -> str:
    return " ".join(value.split()) if isinstance(value, str) else ""


def _time(value: object) -> datetime | None:
    return site_source._when(value)


def _recent(value: object, now: datetime) -> bool:
    stamp = _time(value)
    return stamp is not None and -FUTURE_TOLERANCE <= now - stamp <= MAX_AGE


def make_pack(data: dict, now: datetime) -> dict:
    """Choose deterministic, diverse examples; refuse stale data or a thin set of fields."""
    if now.tzinfo is None:
        raise ValueError("now must include a timezone")
    now = now.astimezone(timezone.utc)
    export = _time(data.get("generated_at"))
    if not _recent(data.get("generated_at"), now):
        raise ValueError("export timestamp is missing, in the future, or more than 48 hours old")
    rows = []
    for row in data.get("listings", []):
        if not isinstance(row, dict):
            continue
        title, employer = _text(row.get("title")), _text(row.get("company_name"))
        if (
            row.get("status") != "open"
            or not row.get("id")
            or not source_url(row.get("apply_url"))
            or not _recent(row.get("last_seen"), now)
            or not title
            or len(title) > 110
            or not employer
            or len(employer) > 80
            or GRADUATE_TITLE.search(title)
            or not set(row.get("keys") or []) & set(STATES)
            or not set(row.get("stage") or []) & {"internship", "co_op", "research"}
        ):
            continue
        rows.append(row)
    # Break ties explicitly, including when the same role appears in several shards.
    rows.sort(key=lambda r: (str(r["id"]), r["apply_url"]))
    rows.sort(
        key=lambda r: _time(r.get("first_seen")) or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )
    # Merge connected duplicate groups, including a copy sharing a URL with one
    # row and an employer/title with another. Simple sequential sets miss that case.
    parents, owners = list(range(len(rows))), {}

    def root(index):
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    for index, row in enumerate(rows):
        keys = (
            ("id", str(row["id"])),
            ("url", url_key(row["apply_url"])),
            ("role", site_source.employer_key(row["company_name"]), _text(row["title"]).casefold()),
        )
        for key in keys:
            if key in owners:
                a, b = root(index), root(owners[key])
                parents[max(a, b)] = min(a, b)
            else:
                owners[key] = index
    unique = [row for index, row in enumerate(rows) if root(index) == index]
    from campaign import tagged, week_tag

    campaign = f"title-discovery-{week_tag(now)}"
    sheets = []
    for field in FIELDS:
        candidates = [r for r in unique if field in (r.get("field_tags") or [])]
        if len(candidates) < MIN_ROLES:
            continue
        selected, titles, employers = [], set(), set()
        for row in candidates:
            title, employer = _text(row["title"]), _text(row["company_name"])
            # Field tagging alone confuses energy/financial markets with marketing.
            # Keep the tagged-supply denominator, but require an explicit marketing
            # term in the title before using it as a marketing search example.
            if field == "marketing" and not MARKETING_EXAMPLE.search(title):
                continue
            title_key, employer_key = title.casefold(), site_source.employer_key(employer)
            if title_key in titles or employer_key in employers or len(title.split()) < 2:
                continue
            titles.add(title_key)
            employers.add(employer_key)
            selected.append(
                {
                    "id": str(row["id"]),
                    "title": title,
                    "employer": employer,
                    "source_title": row["title"],
                    "source_company_name": row["company_name"],
                    "source_url": row["apply_url"],
                    "field_tags": row["field_tags"],
                    "last_seen": row["last_seen"],
                    "first_seen": row.get("first_seen"),
                    "locations": sorted(set(row["keys"]) & set(STATES)),
                }
            )
            if len(selected) == TITLES_PER_SHEET:
                break
        if len(selected) != TITLES_PER_SHEET:
            continue
        label = site_taxonomy.field_title(field)
        url = site_assets.SITE + "/?" + urlencode({"field": field, "state": ",".join(STATES)}, safe=",")
        sheet = {
            "field": field,
            "field_label": label,
            "image": f"{field}.png",
            "dashboard_url": url,
            "eligible_distinct_title_employer_pairs": len(candidates),
            "eligible_role_ids": sorted(str(r["id"]) for r in candidates),
            "roles": selected,
        }
        sheet["caption"] = (
            f"Searching for {label.lower()} internships? Try these actual posting titles.\n\n"
            + "\n".join(f"{r['title']} | {r['employer']}" for r in selected)
            + f"\n\nExamples tagged {label} in InternScout's Northeast / remote results. "
            + f"Snapshot: {export:%Y-%m-%d %H:%M} UTC. {SNAPSHOT_NOTE}\n"
            + f"{ELIGIBILITY_NOTE}\n\nSearch the field: {url}\n"
            + "Keep this list for your next search or send it to a classmate exploring this field."
        )
        path = url.removeprefix(site_assets.SITE)
        sheet["captions_by_channel"] = {
            channel: sheet["caption"].replace(
                url, tagged(path, channel, campaign, f"titles_{field}")
            )
            for channel in CHANNELS
        }
        sheets.append(sheet)
        if len(sheets) == SHEET_COUNT:
            break
    if len(sheets) != SHEET_COUNT:
        raise ValueError(
            "need three fields with 30 recent distinct title/employer pairs and four different employers"
        )
    oldest = min([export] + [_time(r["last_seen"]) for s in sheets for r in s["roles"]])
    return {
        "schema_version": 1,
        "generated_at": now.isoformat(),
        "snapshot_at": export.isoformat(),
        "expires_at": (oldest + MAX_AGE).isoformat(),
        "published": False,
        "campaign": campaign,
        "eligibility_note": ELIGIBILITY_NOTE,
        "snapshot_note": SNAPSHOT_NOTE,
        "scope": "Northeast US and remote listing shards; field tags are not majors",
        "methodology": "Open internship/co-op/research rows, export and last_seen within 48 hours. "
        "Public HTTPS source URLs, excluding known aggregators; dedupe by ID, URL and employer/title. "
        "Pick configured non-CS fields with 30 eligible pairs, then four recent titles "
        "from distinct employers. Exclude titles explicitly naming PharmD, PhD, doctoral or MBA; "
        "this does not prove undergraduate eligibility for remaining rows. "
        "Marketing examples require an explicit marketing/advertising/brand/communications/"
        "social media/content title term; tagged supply counts retain all otherwise eligible rows. "
        "Title and employer whitespace normalized only. "
        "No source-page fetch or independent live-availability verification.",
        "sheets": sheets,
    }


def render_sheet(sheet: dict, snapshot_at: str):
    """Reuse the campaign's palette/fonts; never silently truncate a factual title."""
    from PIL import Image, ImageDraw
    from cards import ACCENT, INK, INK2, PAPER, SOFT, font

    image = Image.new("RGB", (1080, 1350), PAPER)
    draw = ImageDraw.Draw(image)
    margin, width = 72, 936

    def lines(text, size, role="sans", max_lines=3):
        for px in range(size, 23, -1):
            f = font(role, px)
            out, line = [], ""
            for word in text.split():
                trial = (line + " " + word).strip()
                if draw.textlength(trial, font=f) > width:
                    if not line or draw.textlength(word, font=f) > width:
                        break
                    out.append(line)
                    line = word
                else:
                    line = trial
            else:
                out.append(line)
                if len(out) <= max_lines:
                    return f, out, round(px * 1.22)
        raise ValueError("text cannot fit without truncation")

    draw.rectangle((0, 0, 1080, 176), fill=ACCENT)
    draw.text((margin, 35), "InternScout", font=font("serif", 42), fill=PAPER)
    f, text, step = lines(sheet["field_label"], 44, "sans_bold", 1)
    draw.text((margin, 100), text[0], font=f, fill=PAPER)
    draw.text((margin, 211), "Try these job titles", font=font("serif", 58), fill=INK)
    draw.text(
        (margin, 290), "Four real postings to broaden your search", font=font("sans", 32), fill=INK2
    )
    y = 361
    for index, row in enumerate(sheet["roles"], 1):
        draw.line((margin, y - 17, 1008, y - 17), fill=SOFT, width=3)
        f, text, step = lines(row["title"], 37, "sans_bold", 2)
        for line in text:
            draw.text((margin, y), line, font=f, fill=INK)
            y += step
        f, text, step = lines(row["employer"], 28, "sans", 1)
        draw.text((margin, y + 8), text[0], font=f, fill=INK2)
        y = 361 + index * 158
    draw.rectangle((0, 1015, 1080, 1350), fill=SOFT)
    y = 1043
    for text in (
        "Northeast / remote examples. Listed open in the snapshot.",
        ELIGIBILITY_NOTE,
        f"Snapshot: {_time(snapshot_at):%Y-%m-%d %H:%M} UTC. Recheck availability.",
    ):
        f, text_lines, step = lines(text, 27, max_lines=2)
        for line in text_lines:
            draw.text((margin, y), line, font=f, fill=INK2)
            y += step
        y += 11
    draw.text(
        (margin, 1285), "internscout.org  |  Free search", font=font("sans_bold", 31), fill=ACCENT
    )
    return image


def build(site_dir: str, out_dir: str, now: datetime | None = None) -> dict:
    pack = make_pack(site_source.load(site_dir), now or datetime.now(timezone.utc))
    # Render all sheets before writing; a layout failure cannot leave a half-written new pack.
    images = [
        (sheet["image"], render_sheet(sheet, pack["snapshot_at"])) for sheet in pack["sheets"]
    ]
    out = Path(out_dir)
    if out.exists() and any(out.iterdir()):
        raise ValueError("output directory must be empty; use a new dated directory")
    out.mkdir(parents=True, exist_ok=True)
    for name, image in images:
        image.save(out / name, format="PNG")
    (out / "pack.json").write_text(
        json.dumps(pack, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    (out / "captions.json").write_text(
        json.dumps(
            {s["field"]: s["captions_by_channel"] for s in pack["sheets"]},
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (out / "captions.txt").write_text(
        "\n\n---\n\n".join(
            f"{s['field_label']} / {channel}\n\n{caption}"
            for s in pack["sheets"]
            for channel, caption in s["captions_by_channel"].items()
        )
        + "\n",
        encoding="utf-8",
    )
    (out / "REVIEW.txt").write_text(
        "DRAFTS ONLY. Nothing has been posted.\n\n"
        "Before release, open all 12 source URLs in pack.json and confirm the posting, title and current availability.\n"
        "The generator checks export evidence, not live employer pages. Check qualifications separately.\n"
        f"Regenerate before {pack['expires_at']}; discard stale graphics.\n"
        "Use the existing publishing owner. Check scheduled posts to avoid duplicates.\n"
        "Do not promise a clickable TikTok/Instagram bio link until verified in that account.\n"
        "The supplied dashboard URL is a filtered search; it does not freeze these exact examples.\n"
        "Channel captions use only the existing bounded anonymous campaign tags. Intent counts are not confirmed installs or subscribers.\n"
        "Four examples are not a complete list, a job-market estimate or degree-eligibility advice.\n",
        encoding="utf-8",
    )
    return pack


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site_dir", nargs="?", default="docs")
    parser.add_argument("--out", default="title-discovery")
    args = parser.parse_args(argv)
    try:
        pack = build(args.site_dir, args.out)
    except (ValueError, OSError) as error:
        print(f"[title-discovery] refused: {error}", file=sys.stderr)
        return 1
    message = f"[title-discovery] wrote {len(pack['sheets'])} draft sheets"
    if os.environ.get("INTERNSCOUT_LOG_FORMAT") != "json":
        message += f" to {args.out}"
    console(message + "; nothing posted")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
