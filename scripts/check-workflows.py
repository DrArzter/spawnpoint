#!/usr/bin/env python3
"""Hygiene checks for this repository's GitHub Actions workflows.

Three properties matter enough to fail a build over, and none of them is
visible by reading a green tick:

* the workflow runs the same command a developer runs, rather than a second
  copy of the rungs that can drift from it;
* it holds no cloud identity — no OIDC, no secrets, no AWS action — because a
  check that can create resources is no longer only a check;
* every action is pinned to a commit, since a tag can move under us.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parent.parent / ".github" / "workflows"
PINNED = re.compile(r"uses:\s*([\w.-]+/[\w.-]+)@([0-9a-f]{40})\s+#\s*v")
USES = re.compile(r"uses:\s*(\S+)")
# Rungs that belong to scripts/check.sh. A workflow naming one directly has
# started keeping its own copy of the ladder.
DUPLICATED = ("terraform test", "npm test", "apk add", "shellcheck -x")


def check(path: Path) -> list[str]:
    text = path.read_text()
    problems: list[str] = []

    # The version comment sits after the reference, so the whole line is the
    # unit to check rather than the match.
    for line in text.splitlines():
        match = USES.search(line)
        if match is None:
            continue
        if not PINNED.search(line):
            problems.append(f"{match.group(1)} is not pinned to a 40-character commit with a version comment")

    if "permissions:" not in text:
        problems.append("no permissions block: a workflow without one inherits the repository default")
    else:
        granted = re.search(r"permissions:\s*\n((?:\s+\S+:\s*\S+\n)+)", text)
        scopes = dict(
            line.strip().split(":", 1) for line in (granted.group(1).splitlines() if granted else []) if ":" in line
        )
        cleaned = {name: value.strip() for name, value in scopes.items()}
        if cleaned != {"contents": "read"}:
            problems.append(f"permissions must be exactly contents: read, found {cleaned}")

    for forbidden, reason in (
        ("id-token", "OIDC would give this workflow a cloud identity"),
        ("aws-actions/", "an AWS action means credentials"),
        ("${{ secrets.", "a check needs no secret; one that has them can do more than check"),
    ):
        if forbidden in text:
            problems.append(f"{forbidden} is present — {reason}")

    if "scripts/check.sh" not in text:
        problems.append("does not run scripts/check.sh, so it cannot be the same ladder a developer runs")
    for duplicated in DUPLICATED:
        if duplicated in text:
            problems.append(f"runs {duplicated!r} directly instead of through scripts/check.sh")

    return problems


def main() -> int:
    workflows = sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))
    if not workflows:
        print("no workflows found; nothing to check")
        return 0

    failed = False
    for path in workflows:
        problems = check(path)
        if problems:
            failed = True
            for problem in problems:
                print(f"{path.relative_to(WORKFLOWS.parent.parent)}: {problem}", file=sys.stderr)
    if failed:
        return 1
    print(f"workflow hygiene: {len(workflows)} checked")
    return 0


if __name__ == "__main__":
    sys.exit(main())
