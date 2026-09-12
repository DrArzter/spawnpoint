#!/usr/bin/env python3
"""Classify a tested git change into independently deployable production units."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

TERRAFORM_ROOTS = (
    "infra/terraform-guardrails",
    "infra/terraform-storage",
    "infra/terraform",
    "infra/terraform-releases",
    "infra/terraform-operations",
    "infra/terraform-access",
    "infra/terraform-bot",
    "infra/terraform-access-api",
    "infra/terraform-web",
)

# This root is deliberately review-and-apply only: the production deployment
# identity must never be able to rewrite its own trust policy.  A PR still has
# to prove that it produces a valid, non-destructive plan.
PLAN_ONLY_TERRAFORM_ROOTS = ("infra/terraform-github",)

WORKFLOW_ROOTS = {
    "workflows/start-server.asl.json": "infra/terraform",
    "workflows/stop-server.asl.json": "infra/terraform",
    "workflows/idle-watchdog.asl.json": "infra/terraform-operations",
    "workflows/promote-release.asl.json": "infra/terraform-operations",
    "workflows/start-server-v2.asl.json.tftpl": "infra/terraform-operations",
    "workflows/stop-server-v2.asl.json.tftpl": "infra/terraform-operations",
    "workflows/idle-watchdog-v2.asl.json.tftpl": "infra/terraform-operations",
    "workflows/build-release.asl.json.tftpl": "infra/terraform-releases",
    "workflows/publish-preset-catalog.asl.json.tftpl": "infra/terraform-releases",
    "workflows/world-lifecycle.asl.json.tftpl": "infra/terraform-access-api",
}


def changed_paths(before: str, after: str) -> list[str]:
    zero = "0" * 40
    if before == zero:
        command = ["git", "ls-tree", "-r", "--name-only", after]
    else:
        command = ["git", "diff", "--name-only", before, after]
    try:
        return subprocess.run(command, check=True, text=True, capture_output=True).stdout.splitlines()
    except subprocess.CalledProcessError:
        return ["__all_production_units__"]


def make_plan(paths: list[str]) -> dict[str, object]:
    normalized = {Path(path).as_posix().removeprefix("./") for path in paths if path}
    deploy_all = "__all_production_units__" in normalized
    roots: set[str] = set(TERRAFORM_ROOTS if deploy_all else ())
    plan_roots: set[str] = set((*TERRAFORM_ROOTS, *PLAN_ONLY_TERRAFORM_ROOTS) if deploy_all else ())
    manual: list[str] = []
    web = deploy_all
    lambdas = deploy_all
    if deploy_all:
        manual.append("the previous commit is unavailable; refusing to infer a production diff")

    for path in normalized:
        if path.startswith("web/") or path == "scripts/deploy-web.sh":
            web = True
        if path.startswith("lambdas/") or path == "scripts/deploy-lambdas.sh":
            lambdas = True

        if path.startswith("infra/terraform-bootstrap/"):
            manual.append("terraform-bootstrap uses local bootstrap state and is never auto-applied")
            continue
        if path.startswith("infra/terraform-github/"):
            plan_roots.add("infra/terraform-github")
            manual.append("the GitHub deployment identity cannot auto-modify its own trust or permissions")
            continue

        matched_root = next((root for root in TERRAFORM_ROOTS if path.startswith(f"{root}/")), None)
        if matched_root is not None:
            roots.add(matched_root)
            plan_roots.add(matched_root)
            if matched_root in {"infra/terraform-web", "infra/terraform-access-api"}:
                web = True
            continue

        workflow_root = WORKFLOW_ROOTS.get(path)
        if workflow_root is not None:
            roots.add(workflow_root)
            plan_roots.add(workflow_root)
            continue
        if path.startswith("workflows/"):
            roots.update(("infra/terraform", "infra/terraform-operations", "infra/terraform-releases", "infra/terraform-access-api"))
            plan_roots.update(("infra/terraform", "infra/terraform-operations", "infra/terraform-releases", "infra/terraform-access-api"))

        if path.startswith("server/"):
            roots.update(("infra/terraform", "infra/terraform-releases"))
            plan_roots.update(("infra/terraform", "infra/terraform-releases"))
            if path == "server/user-data.sh":
                manual.append("host user-data changes require a reviewed EC2 replacement or an explicit live-host rollout")

        if path in {"scripts/aws-release-builder.sh", "scripts/aws-preset-catalog-builder.sh", "scripts/_config-source.sh"}:
            roots.add("infra/terraform-releases")
            plan_roots.add("infra/terraform-releases")

        if path.startswith("infra/") and matched_root is None and not path.startswith("infra/terraform-bootstrap/"):
            roots.update(TERRAFORM_ROOTS)
            plan_roots.update((*TERRAFORM_ROOTS, *PLAN_ONLY_TERRAFORM_ROOTS))

    ordered_roots = [root for root in TERRAFORM_ROOTS if root in roots]
    ordered_plan_roots = [root for root in (*TERRAFORM_ROOTS, *PLAN_ONLY_TERRAFORM_ROOTS) if root in plan_roots]
    return {
        "web": web,
        "lambdas": lambdas,
        "infrastructure": bool(ordered_roots),
        "terraform_roots": ordered_roots,
        "terraform_plan_roots": ordered_plan_roots,
        "manual_review": sorted(set(manual)),
        "changed_paths": sorted(normalized),
    }


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: deployment_plan.py <before-sha> <after-sha>", file=sys.stderr)
        return 2
    print(json.dumps(make_plan(changed_paths(sys.argv[1], sys.argv[2])), separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
