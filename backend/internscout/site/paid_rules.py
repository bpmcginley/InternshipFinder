"""Read paid-listing eligibility facts without loading placement storage."""


def unpaid(x: dict) -> bool:
    """The listing says the role is unpaid, read as the dashboard's IS.payOf reads it: the first of
    paid, unpaid or stipend in its restrictions, else insights.pay."""
    r = next((t for t in x.get("restrictions") or [] if t in ("paid", "unpaid", "stipend")), None)
    return (r or (x.get("insights") or {}).get("pay")) == "unpaid"


def _deadline_passed(x: dict, today: str) -> bool:
    deadline = str((x.get("insights") or {}).get("deadline") or "")[:10]
    return bool(deadline) and deadline < today
