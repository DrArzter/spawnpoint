#!/usr/bin/env python3
"""Choose the revision a production deploy is measured from: the last one deployed.

Measured from the push before it, a deploy lost every change whose own deploy
never ran: a Check cancelled by the next merge, a queued deploy replaced by a
newer one, a deploy that failed. Measured from the last successful deploy, the
next deploy carries all of them.

Usage: deployment_base.py <head-sha> < titles
The titles are those of successful `Deploy production` runs, newest first.
Prints the base revision; the reason goes to standard error.
"""

from __future__ import annotations

import re
import subprocess
import sys
from collections.abc import Callable, Iterable

from deployment_plan import validated_revision

# deploy-production.yml names each run after the revision it deploys.
TITLE = re.compile(r"Deploy production ([0-9a-f]{40})")

# Before any run carried its revision in its title: the last revision every
# production unit is known to have reached (#98). The deploys after it skipped
# or failed the access API root.
FIRST_BASE = "a0caabcb269b770b97562f79760198bb08e213a3"


def last_deployed(titles: Iterable[str]) -> str | None:
    for title in titles:
        match = TITLE.fullmatch(title.strip())
        if match is not None:
            return match.group(1)
    return None


def choose_base(
    titles: Iterable[str],
    head: str,
    is_ancestor: Callable[[str, str], bool],
    first_base: str = FIRST_BASE,
    main: str = "HEAD",
) -> tuple[str, str]:
    head = validated_revision(head)
    # The checkout is main: a commit outside it, such as a fork's, is never deployed.
    if not is_ancestor(head, main):
        raise ValueError(f"{head} is not on main")
    deployed = last_deployed(titles) or first_base
    if deployed == head or is_ancestor(head, deployed):
        # A rerun of an older deploy must not put older code back.
        return head, f"{deployed} is deployed and already contains {head}; nothing to deploy"
    if is_ancestor(deployed, head):
        return deployed, f"measuring from the last deployed revision {deployed}"
    raise ValueError(f"the last deployed revision {deployed} is not in the history of {head}")


def git_is_ancestor(ancestor: str, descendant: str) -> bool:
    return subprocess.run(["git", "merge-base", "--is-ancestor", ancestor, descendant], check=False).returncode == 0


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: deployment_base.py <head-sha> < titles", file=sys.stderr)
        return 2
    try:
        base, reason = choose_base(sys.stdin.read().splitlines(), sys.argv[1], git_is_ancestor)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(reason, file=sys.stderr)
    print(base)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
