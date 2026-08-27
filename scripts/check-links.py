#!/usr/bin/env python3
"""Every relative markdown link in the repository resolves to a real file."""

import re
import sys
from pathlib import Path

root = Path(__file__).resolve().parent.parent
pattern = re.compile(r"\[[^\]]*\]\(([^)]+)\)")
bad: list[str] = []
count = 0
for md in root.rglob("*.md"):
    if ".terraform" in md.parts or "node_modules" in md.parts:
        continue
    for match in pattern.finditer(md.read_text()):
        target = match.group(1).split("#")[0].strip()
        if not target or target.startswith(("http://", "https://", "mailto:")):
            continue
        count += 1
        if not (md.parent / target).resolve().exists():
            bad.append(f"{md.relative_to(root)} -> {target}")

print(f"checked {count} local links")
if bad:
    print("BROKEN:")
    print("\n".join(bad))
    sys.exit(1)
print("all local links resolve")
