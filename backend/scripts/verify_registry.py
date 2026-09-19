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
    scan_boards(again, verbose=False)
    spared = [(a, t) for a, t in dead if reg[a][t]["fails"] < MAX_FAILS]
    for a, t in spared:
        print(f"kept {a}:{t} (answered on the second try)")
    dead = [d for d in dead if d not in spared]
for a, t in dead:
    del reg[a][t]
    print(f"dropped {a}:{t}")
save_registry(reg)
print(f"{len(dead)} dropped; {sum(len(e) for e in reg.values())} boards remain")
