"""Conservative salary display checks. Never guess an upstream amount's intended unit."""
import re

_AMOUNT = re.compile(r"\d[\d,]*(?:\.\d+)?\s*[kK]?")
_ANNUAL = re.compile(r"\b(year|yr|annum|annual|annually)\b", re.I)
_MONEY = re.compile(r"-?\$\s*-?\s*\d[\d,]*(?:\.\d+)?\s?[kK]?(?:\s?(?:[-\u2013]|to)\s?\$?\s?\d[\d,]*(?:\.\d+)?\s?[kK]?)?(?:\s?(?:/|per\s)?\s?(?:hour|hr|year|yr|annum|annually|month|mo|week|wk|day))?", re.I)


def placeholder_pay(salary) -> bool:
    # 2026-10-23: was zero-only in seo_pages/client. Tiny explicitly annual USD amounts are
    # malformed compensation, not evidence of paid work. No minimum-wage or currency guesses.
    # Revert: remove the annual check here and the matching core.js check together.
    text = str(salary or "")
    # 2026-10-23: negative employer amounts are unknown, not a paid compensation claim.
    # Revert: remove this guard and its client/extractor equivalents together.
    if re.search(r"^\s*(?:(?:USD|CAD|US|CA)\s*)?-\s*\$|\$\s*-\s*\d", text, re.I):
        return True
    amounts = []
    for raw in _AMOUNT.findall(text):
        raw = raw.strip()
        amounts.append(float(raw.rstrip("kK").replace(",", "")) * (1000 if raw[-1:] in ("k", "K") else 1))
    return bool(amounts) and (amounts[0] == 0 or (
        "$" in text and _ANNUAL.search(text) and max(amounts) < 1000))


def only_placeholder_amounts(text) -> bool:
    """Prevent description dollar detection from turning rejected amounts back into Paid."""
    matches = _MONEY.findall(str(text or ""))
    return bool(matches) and all(placeholder_pay(value) for value in matches)
