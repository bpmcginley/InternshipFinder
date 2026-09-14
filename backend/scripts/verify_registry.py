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
for entries in reg.values():
    for e in entries.values():
        e["fails"] = MAX_FAILS - 1          # one more failure = dropped
scan_boards(reg)
dead = [(a, t) for a, e in reg.items() for t, v in e.items() if v["fails"] >= MAX_FAILS]
for a, t in dead:
    del reg[a][t]
    print(f"dropped {a}:{t}")
save_registry(reg)
print(f"{len(dead)} dropped; {sum(len(e) for e in reg.values())} boards remain")
