"""Get the YouTube refresh token for growth/youtube.py, once, on the owner's own machine. Added 2026-10-02.

This is Google's "installed app" sign-in with a loopback redirect: it starts a one-request web server
on 127.0.0.1, opens Google's consent page in the browser, and Google sends the browser back to that
server with a code, which is traded for a refresh token (with PKCE, so a stolen code is useless).
Nothing leaves this machine except the calls to Google, and nothing is saved to disk.

  python growth/youtube_auth.py

It asks for the Desktop app client's ID and secret (or reads YOUTUBE_CLIENT_ID and
YOUTUBE_CLIENT_SECRET), opens the browser, and then prints the channel the token belongs to (check it
says InternScout: choose the brand channel, not a personal one, when Google asks) and the refresh
token. Paste the token only into GitHub:

  gh secret set YOUTUBE_REFRESH_TOKEN --repo bpmcginley/InternshipFinder

Scopes: youtube.upload to upload, youtube.readonly to read the channel's name and its last few uploads
(growth/youtube.py checks those so a rerun can't post the same Short twice). Standard library only.
"""
from __future__ import annotations

import base64
import getpass
import hashlib
import http.server
import json
import os
import secrets
import sys
import urllib.parse
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import youtube  # noqa: E402  (the same HTTP helper and error messages as the uploader)

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
SCOPES = ("https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly")
WAIT = 300      # seconds to wait for the browser to come back


def pkce() -> tuple[str, str]:
    """(verifier, S256 challenge)."""
    verifier = secrets.token_urlsafe(64)[:128]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def consent_url(client_id: str, redirect_uri: str, challenge: str, state: str) -> str:
    # access_type=offline asks for a refresh token; prompt=consent makes Google issue a new one even
    # if this client was allowed before (it sends one only on a consent).
    return AUTH_URL + "?" + urllib.parse.urlencode({
        "client_id": client_id, "redirect_uri": redirect_uri, "response_type": "code",
        "scope": " ".join(SCOPES), "access_type": "offline", "prompt": "consent",
        "code_challenge": challenge, "code_challenge_method": "S256", "state": state,
    })


def wait_for_code(server: http.server.HTTPServer, state: str) -> str:
    """The code Google sends the browser back with, from the one request the server takes."""
    got: dict = {}

    class Back(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 (the name http.server calls)
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            got.update({k: v[0] for k, v in q.items()})
            ok = "code" in got and got.get("state") == state
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(("<p>Done. You can close this tab and go back to the terminal.</p>" if ok else
                              "<p>That didn't work; see the terminal.</p>").encode())

        def log_message(self, *a):      # the request line carries the code; keep it off the terminal
            pass

    server.RequestHandlerClass = Back
    server.timeout = WAIT
    server.handle_request()
    if got.get("state") != state:
        raise SystemExit("[youtube_auth] no answer from the browser, or one that wasn't for this sign-in")
    if "code" not in got:
        raise SystemExit(f"[youtube_auth] Google said: {got.get('error', 'no code')}")
    return got["code"]


def exchange(client_id: str, client_secret: str, code: str, verifier: str, redirect_uri: str) -> dict:
    form = urllib.parse.urlencode({"client_id": client_id, "client_secret": client_secret, "code": code,
                                   "code_verifier": verifier, "redirect_uri": redirect_uri,
                                   "grant_type": "authorization_code"}).encode()
    _, _, body = youtube._call("POST", youtube.TOKEN_URL, data=form,
                               headers={"Content-Type": "application/x-www-form-urlencoded"}, timeout=30)
    return json.loads(body)


def channel_name(access_token: str) -> str:
    _, _, body = youtube._call("GET", f"{youtube.API}/channels?part=snippet&mine=true", token=access_token)
    items = json.loads(body).get("items") or []
    return items[0]["snippet"]["title"] if items else "(no channel: this account has no YouTube channel)"


def main() -> int:
    client_id = os.environ.get("YOUTUBE_CLIENT_ID") or input("Desktop app client ID: ").strip()
    client_secret = os.environ.get("YOUTUBE_CLIENT_SECRET") or getpass.getpass("Client secret (not shown): ").strip()
    server = http.server.HTTPServer(("127.0.0.1", 0), http.server.BaseHTTPRequestHandler)
    redirect_uri = f"http://127.0.0.1:{server.server_port}"
    verifier, challenge = pkce()
    state = secrets.token_urlsafe(16)
    url = consent_url(client_id, redirect_uri, challenge, state)
    print("Opening Google's sign-in. If no browser opens, paste this address into one:\n\n" + url + "\n")
    print("Choose the InternScout channel when Google asks which account or channel to use. While the app is\n"
          "unverified Google shows 'Google hasn't verified this app': as its developer, click Advanced, then\n"
          "Go to InternScout, and allow both permissions.\n")
    webbrowser.open(url)
    try:
        code = wait_for_code(server, state)
    finally:
        server.server_close()
    try:
        tokens = exchange(client_id, client_secret, code, verifier, redirect_uri)
        name = channel_name(tokens["access_token"])
    except youtube.YouTubeError as e:
        print(f"[youtube_auth] failed: {e}")
        return 1
    if not tokens.get("refresh_token"):
        print("[youtube_auth] Google sent no refresh token. Remove the app's access at "
              "myaccount.google.com/permissions and run this again.")
        return 1
    print(f"Channel: {name}")
    if name != "InternScout":
        print("  That is not the InternScout channel. Run this again and pick InternScout when Google asks.")
    print("\nRefresh token (paste it only into GitHub, then clear this terminal):\n")
    print(tokens["refresh_token"])
    print("\n  gh secret set YOUTUBE_REFRESH_TOKEN --repo bpmcginley/InternshipFinder")
    return 0


if __name__ == "__main__":
    sys.exit(main())
