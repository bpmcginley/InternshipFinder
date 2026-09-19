"""Check every board in backend/data/ats_registry.json live and drop the dead ones.

  cd backend && python scripts/verify_registry.py
"""
import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from internscout.discover import load_registry, save_registry, seed_registry, MAX_FAILS
from internscout.run_ingest import scan_boards

reg = load_registry()
seed_registry(reg)
def arm(entries):
    for e in entries:
        e["fails"] = MAX_FAILS - 1          # one more failure = dropped
        e.pop("last_fail", None)            # failures count once a day now; without this a board that
                                            # already failed in today's ingest could never be dropped here


# Arming writes MAX_FAILS - 1 on every board, and a board the scan neither passed nor failed (its ATS
# tripped the systemic guard, or its second failure was a throttle) used to be saved that way: one bad
# day from deletion, for having been checked. What each board had is kept here and put back at the end.
before = {(a, t): (v.get("fails", 0), v.get("last_fail")) for a, e in reg.items() for t, v in e.items()}
arm(e for entries in reg.values() for e in entries.values())
scan_boards(reg)
dead = [(a, t) for a, e in reg.items() for t, v in e.items() if v["fails"] >= MAX_FAILS]
# One failed request used to be enough to delete a board for good (was: drop `dead` as it stands).
# A 429 or a slow minute at the ATS is not a dead board, so the ones that failed are asked once more,
# on their own and after a pause, and only a board that fails both times goes.
if dead:
    import time
    time.sleep(20)
    again = {a: {t: reg[a][t] for aa, t in dead if aa == a} for a in {a for a, _ in dead}}
    arm(e for entries in again.values() for e in entries.values())
    # was: scan_boards(again, verbose=False). `again` holds only boards that failed, so every ATS in it
    # fails on all its boards, the systemic guard skipped them all, and ten or more dead boards of one
    # ATS were "kept ... (answered on the second try)" without having answered.
    scan_boards(again, verbose=False, systemic_guard=False)
    spared = [(a, t) for a, t in dead if reg[a][t]["fails"] < MAX_FAILS]
    for a, t in spared:
        # was: always "(answered on the second try)"
        how = "answered on the second try" if reg[a][t]["fails"] == 0 else "throttled on the second try, left as it was"
        print(f"kept {a}:{t} ({how})")
    dead = [d for d in dead if d not in spared]
for a, t in dead:
    del reg[a][t]
    print(f"dropped {a}:{t}")
for a, e in reg.items():
    for t, v in e.items():
        if v.get("fails", 0) and (a, t) in before:      # never answered, never dropped: as it was
            v["fails"], last = before[a, t]
            v.pop("last_fail", None)
            if last:
                v["last_fail"] = last
save_registry(reg)
print(f"{len(dead)} dropped; {sum(len(e) for e in reg.values())} boards remain")
