"""Pure text and link formatting helpers for published pages."""

from __future__ import annotations


def safe_url(url) -> str | None:
    u = (url or "").strip()
    return u if u.lower().startswith(("https://", "http://")) else None


def plural(n: int, one: str, many: str | None = None) -> str:
    return f"{n:,} {one if n == 1 else (many or one + 's')}"


def lower_name(name: str) -> str:
    """A field title as it reads mid-sentence: "machine learning and AI", not "... and ai"."""
    return " ".join(w if len(w) > 1 and w.isupper() else w.lower() for w in name.split())


def join_words(words: list[str]) -> str:
    words = [w for w in words if w]
    return (
        words[0]
        if len(words) == 1
        else ", ".join(words[:-1]) + " and " + words[-1]
        if words
        else ""
    )


def possessive(name: str) -> str:
    """ "Bose's", "Mars's"; "the employer's" for a name too long or too odd to read well that way."""
    return "the employer's" if len(name) > 24 or not name[-1:].isalnum() else f"{name}'s"


def money(v: float) -> str:
    return f"${v:,.2f}".replace(".00", "")


def pct(k: int, n: int) -> str:
    """k of n as a whole percent, rounded down like summary()'s "N% list pay"."""
    return f"{k * 100 // n}%" if n else "0%"
