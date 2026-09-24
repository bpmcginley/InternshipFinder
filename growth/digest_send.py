"""Send the weekly digest to InternScout's email subscribers through Buttondown.

growth/digest.py writes the email; this sends it as one broadcast to every confirmed subscriber.
Buttondown requires double opt-in, so nobody gets it without confirming first. The subscriber list
lives with Buttondown. InternScout's own servers and this repo never hold an email address.

A send is two calls, as Buttondown's API documents them (API version 2026-04-01, pinned below):
  1. POST /v1/emails with status "draft": the subject, the HTML body and an audience of everyone.
     A draft goes to nobody.
  2. PATCH /v1/emails/<id> to status "about_to_send". Buttondown sends it within a few minutes, and
     until then it can be stopped by setting it back to a draft in the dashboard.
With --test-to, step 2 is POST /v1/emails/<id>/send-draft instead. That sends one copy to that
address and leaves the draft unsent.

Without --send this is a dry run: it prints what it would send and sends nothing. A real send needs
all three of:
  --send                   on the command line
  BUTTONDOWN_API_KEY       a Buttondown API key with email_access and sending_access set to write
  DIGEST_POSTAL_ADDRESS    the postal address (a PO box) CAN-SPAM requires in every email; it may
                           have several lines
With --send and either variable missing or blank, it names what is missing and exits 2 without
calling Buttondown. It also exits 2, sending nothing, in a week with no field to list. When Buttondown
refuses a request or can't be reached, it exits 1.

Run from the repo root:  python growth/digest_send.py [docs] [--send] [--test-to ADDRESS] [--public-archive]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import digest  # noqa: E402

API = "https://api.buttondown.com/v1"
# Pinned, so a different version set on the newsletter or on the key can't change what these calls do.
API_VERSION = "2026-04-01"
KEY_ENV = "BUTTONDOWN_API_KEY"
ADDRESS_ENV = "DIGEST_POSTAL_ADDRESS"
# Cloudflare and some APIs turn away Python's default user agent, so every request names itself.
UA = {"User-Agent": "InternScout-digest/1.0 (+https://internscout.org)"}

# Buttondown reads a body that starts with this marker as raw HTML, not Markdown.
FANCY = "<!-- buttondown-editor-mode: fancy -->"
# Buttondown's personal unsubscribe link for each subscriber. digest.py leaves its own placeholder
# (digest.UNSUBSCRIBE) where the link goes, and body_html maps it to this.
UNSUBSCRIBE = "{{ unsubscribe_url }}"
# An empty filter list is Buttondown's "every subscriber".
EVERYONE = {"filters": [], "groups": [], "predicate": "and"}
EMAIL = re.compile(r"[^@\s,;<>\"']+@[^@\s,;<>\"']+\.[A-Za-z]{2,}")
EMAIL_ID = re.compile(r"[A-Za-z0-9_-]+")

EXIT_PROVIDER, EXIT_REFUSED = 1, 2


class ProviderError(Exception):
    """Buttondown refused a request or could not be reached. The message says which and why."""


class NoAnswer(ProviderError):
    """No answer at all: the request may or may not have reached Buttondown. For the final send that
    means the email may already be going out, which is not the same as "not sent"."""


# ---------------------------------------------------------------- the email

def subject(d: dict) -> str:
    """The subject, with the week's date in it. Buttondown has an email_duplicate error whose trigger
    it doesn't document, and a subject that names its week is at least never the same twice."""
    return f"{d['subject']} ({d['week_ending']})"


def body_html(page: str) -> str:
    """The HTML Buttondown gets, made from digest.render_html's page.

    Only what is inside <body> goes: Buttondown puts the body inside its own email template, and a
    second <html> and <body> inside that would be invalid. Buttondown also runs the body through
    Django templates, so a job title with "{{" or "{%" in it could break the email or print a
    subscriber field. Every brace becomes an HTML entity, which looks the same to a reader but is not
    a template tag to Django. The one tag kept is the unsubscribe link, mapped to Buttondown's."""
    m = re.search(r"<body[^>]*>(.*)</body>", page, re.S)
    if not m:
        raise ValueError("digest.render_html returned a page with no <body>")
    # was: parts = m.group(1).split(digest.UNSUBSCRIBE), which also kept a job title that happened to
    # contain the token as a live tag, and let such a title stand in for a missing footer link. Only the
    # footer's own href is kept: job-board text is HTML-escaped, so it can never contain href="...".
    link = f'href="{digest.UNSUBSCRIBE}"'
    parts = m.group(1).split(link)
    if len(parts) != 2:
        raise ValueError(f"the digest needs exactly one unsubscribe link ({link}); found {len(parts) - 1}")
    safe = [p.replace("{", "&#123;").replace("}", "&#125;") for p in parts]
    return FANCY + f'href="{UNSUBSCRIBE}"'.join(safe).strip()


def payload(d: dict, postal_address: str | None, public_archive: bool = False) -> dict:
    """The body of POST /v1/emails: a draft to every subscriber."""
    out = {"subject": subject(d), "body": body_html(digest.render_html(d, postal_address=postal_address)),
           "status": "draft", "filters": EVERYONE}
    if not public_archive:
        # Buttondown posts emails on the newsletter's public web archive unless told not to.
        out["archival_mode"] = "disabled"
    return out


# ---------------------------------------------------------------- Buttondown

def _explain(method: str, path: str, status: int, raw: bytes) -> str:
    text = raw.decode("utf-8", "replace")[:500]
    hint = ""
    if status in (401, 403):
        hint = f" Check {KEY_ENV}: the key needs email_access and sending_access set to write."
    elif "email_duplicate" in text:
        hint = (" Buttondown took this for a duplicate email. Its docs don't say what counts as one, so "
                "look in the dashboard for an email with the same subject before running this again.")
    return f"Buttondown refused {method} {path} ({status}): {text}{hint}"


def call(method: str, path: str, key: str, body: dict | None = None, headers: dict | None = None,
         tries: int = 1) -> dict:
    """One request to Buttondown's API, with its JSON answer. A refusal raises ProviderError at once.
    A network failure is tried again up to tries times, so pass tries > 1 only for a request that is
    safe to repeat."""
    h = {"Authorization": f"Token {key}", "X-API-Version": API_VERSION,
         "Content-Type": "application/json", **UA, **(headers or {})}
    data = json.dumps(body).encode("utf-8") if body is not None else None
    problem = ""
    for _ in range(max(1, tries)):
        req = urllib.request.Request(f"{API}{path}", data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                raw = r.read()
        except urllib.error.HTTPError as e:
            raise ProviderError(_explain(method, path, e.code, e.read() or b"")) from None
        except OSError as e:          # URLError, a timeout or a dropped connection
            problem = f"No answer from Buttondown to {method} {path}: {e}"
            continue
        try:
            return json.loads(raw) if raw.strip() else {}
        except ValueError:
            raise ProviderError(f"Buttondown answered {method} {path} with something that isn't JSON: "
                                f"{raw[:200]!r}") from None
    raise NoAnswer(problem)


def create_draft(key: str, body: dict) -> str:
    """POST /v1/emails, and the new email's id. The idempotency key lets the one retry after a network
    failure return the draft the first try made, if it made one, instead of making a second."""
    created = call("POST", "/emails", key, body, {"X-Idempotency-Key": str(uuid.uuid4())}, tries=2)
    email_id = created.get("id")
    if not isinstance(email_id, str) or not EMAIL_ID.fullmatch(email_id):
        raise ProviderError(f"Buttondown's answer to POST /emails has no usable email id, so nothing more "
                            f"was sent: {json.dumps(created)[:300]}")
    if created.get("status", "draft") != "draft":
        raise ProviderError(f"Buttondown made {email_id} with status {created.get('status')!r}, not "
                            f"'draft'. Stopping; look at it in the dashboard.")
    return email_id


# ---------------------------------------------------------------- command line

def _plan(test_to: str | None) -> list[str]:
    """The requests a real send would make, for the dry run to print."""
    if test_to:
        second = (f"POST {API}/emails/<new id>/send-draft  " + json.dumps({"recipients": [test_to]})
                  + "  (one test copy; the draft stays unsent)")
    else:
        second = f"PATCH {API}/emails/<new id>  " + json.dumps({"status": "about_to_send"}) + "  (every subscriber)"
    return [f"POST {API}/emails  (a draft, with X-API-Version {API_VERSION})", second]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="digest_send.py",
                                 description="Send this week's email digest through Buttondown. Without --send, "
                                             "only print what would be sent.")
    ap.add_argument("site_dir", nargs="?", default="docs", help="a copy of docs/ (reads <site_dir>/data)")
    ap.add_argument("--send", action="store_true",
                    help="really send; needs BUTTONDOWN_API_KEY and DIGEST_POSTAL_ADDRESS")
    ap.add_argument("--test-to", metavar="ADDRESS",
                    help="send one test copy to this address instead of to every subscriber")
    ap.add_argument("--public-archive", action="store_true",
                    help="also post the email on Buttondown's public web archive (off by default)")
    args = ap.parse_args(argv[1:])

    key = (os.environ.get(KEY_ENV) or "").strip()
    address = (os.environ.get(ADDRESS_ENV) or "").strip()
    test_to = None
    if args.test_to is not None:
        test_to = args.test_to.strip()
        if not EMAIL.fullmatch(test_to):
            print(f"[digest] Not sent: --test-to needs one email address, and got {args.test_to!r}. "
                  "The Email digest workflow reads it from the DIGEST_TEST_TO repository variable.")
            return EXIT_REFUSED
    if args.send:
        missing = []
        if not key:
            missing.append(f"{KEY_ENV} (a Buttondown API key with email_access and sending_access set to write)")
        if not address:
            missing.append(f"{ADDRESS_ENV} (the postal address every email must carry, a PO box)")
        if missing:
            print("[digest] Not sent. Missing: " + "; ".join(missing))
            return EXIT_REFUSED

    d = digest.build(args.site_dir)
    empty = (f"no field gained {digest.MIN_NEW} or more new roles this week, so there is nothing to send"
             if not d["sections"] else "")
    email = payload(d, address or None, args.public_archive)

    if not args.send:
        print("[digest] Dry run: nothing was sent.")
        print(f"Subject: {email['subject']}")
        print("To: " + (f"{test_to} only (a test copy)" if test_to else "every confirmed Buttondown subscriber"))
        print("Draft settings: " + json.dumps({k: v for k, v in email.items() if k != "body"}))
        print(f"Body: {len(email['body']):,} characters of HTML")
        print("A real send makes these requests:")
        for line in _plan(test_to):
            print(f"  {line}")
        print("\nThe plain-text version:\n")
        print(digest.render_text(d, postal_address=address or None))
        if empty:
            print(f"[digest] A real send would refuse this week: {empty}.")
        still = ["--send"] + [name for name, value in ((KEY_ENV, key), (ADDRESS_ENV, address)) if not value]
        print("[digest] A real send needs: " + ", ".join(still))
        return 0

    if empty:
        print(f"[digest] Not sent: {empty}.")
        return EXIT_REFUSED
    if digest.NO_ADDRESS in email["body"]:
        # In case digest.py and this script ever disagree about what a blank address is: the email
        # must never go out with the marker where the address belongs.
        print(f"[digest] Not sent: {ADDRESS_ENV} has no printable lines, so the email has no postal address.")
        return EXIT_REFUSED

    try:
        email_id = create_draft(key, email)
    except ProviderError as e:
        print(f"[digest] Not sent. {e}")
        return EXIT_PROVIDER
    print(f"[digest] Made Buttondown draft {email_id}: {email['subject']}")
    try:
        if test_to:
            call("POST", f"/emails/{email_id}/send-draft", key, {"recipients": [test_to]})
            print(f"[digest] Sent one test copy of {email_id} to {test_to}. The draft stays unsent; the next "
                  "run makes a new one.")
        else:
            call("PATCH", f"/emails/{email_id}", key, {"status": "about_to_send"})
            print(f"[digest] {email_id} is on its way to every subscriber. Buttondown sends it within a few "
                  "minutes; until then, setting it back to a draft in the dashboard stops it.")
    except NoAnswer as e:
        # The request may have reached Buttondown before the connection dropped, so the email may be on
        # its way. Saying "not sent" here is how a second run sends everyone a second copy.
        print(f"[digest] No answer to the last step for draft {email_id}, so it may or may not be sending. {e}")
        print("[digest] Check that email's status in Buttondown's dashboard before running this again.")
        return EXIT_PROVIDER
    except ProviderError as e:
        print(f"[digest] Draft {email_id} was made but not sent. {e}")
        print("[digest] Send or delete that draft in Buttondown's dashboard before running this again.")
        return EXIT_PROVIDER
    return 0


if __name__ == "__main__":
    # The dry run prints job-board text, and a Windows console's code page can't show every character.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    sys.exit(main(sys.argv))
