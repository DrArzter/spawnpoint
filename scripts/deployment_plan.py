#!/usr/bin/env python3
"""Classify a tested git change into independently deployable production units."""

from __future__ import annotations

import json
import re
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

TF_CORE = "infra/terraform"
TF_DOMAIN = "infra/terraform-domain"
TF_RELEASES = "infra/terraform-releases"
TF_OPERATIONS = "infra/terraform-operations"
TF_ACCESS_API = "infra/terraform-access-api"
TF_WEB = "infra/terraform-web"
TF_GITHUB = "infra/terraform-github"
TF_IDENTITY_ADMIN = "infra/terraform-identity-admin"
TF_BOOTSTRAP = "infra/terraform-bootstrap"

TERRAFORM_ROOTS = (
    "infra/terraform-guardrails",
    "infra/terraform-storage",
    TF_DOMAIN,
    TF_CORE,
    TF_RELEASES,
    TF_OPERATIONS,
    "infra/terraform-access",
    "infra/terraform-bot",
    TF_ACCESS_API,
    TF_WEB,
)
PLAN_ONLY_TERRAFORM_ROOTS = (TF_GITHUB, TF_IDENTITY_ADMIN)
ALL_PLAN_ROOTS = (*TERRAFORM_ROOTS, *PLAN_ONLY_TERRAFORM_ROOTS)
ALL_WORKFLOW_ROOTS = (TF_CORE, TF_OPERATIONS, TF_RELEASES, TF_ACCESS_API)

WORKFLOW_ROOTS = {
    "workflows/start-server.asl.json": TF_CORE,
    "workflows/stop-server.asl.json": TF_CORE,
    "workflows/idle-watchdog.asl.json": TF_OPERATIONS,
    "workflows/promote-release.asl.json": TF_OPERATIONS,
    "workflows/start-server-v2.asl.json.tftpl": TF_OPERATIONS,
    "workflows/stop-server-v2.asl.json.tftpl": TF_OPERATIONS,
    "workflows/idle-watchdog-v2.asl.json.tftpl": TF_OPERATIONS,
    "workflows/build-release.asl.json.tftpl": TF_RELEASES,
    "workflows/publish-preset-catalog.asl.json.tftpl": TF_RELEASES,
    "workflows/world-lifecycle.asl.json.tftpl": TF_ACCESS_API,
}

RELEASE_SCRIPTS = {
    "scripts/aws-release-builder.sh",
    "scripts/aws-preset-catalog-builder.sh",
    "scripts/_config-source.sh",
}
REVISION = re.compile(r"[0-9a-f]{40}")


@dataclass
class Selection:
    roots: set[str] = field(default_factory=set)
    plan_roots: set[str] = field(default_factory=set)
    manual: list[str] = field(default_factory=list)
    manual_roots: set[str] = field(default_factory=set)
    manual_unverified: list[str] = field(default_factory=list)
    web: bool = False
    lambdas: bool = False
    identity: bool = False

    def add_root(self, root: str) -> None:
        self.roots.add(root)
        self.plan_roots.add(root)

    def add_roots(self, roots: tuple[str, ...]) -> None:
        self.roots.update(roots)
        self.plan_roots.update(roots)


def validated_revision(value: str) -> str:
    """Accept only the full object IDs emitted by GitHub, never git options."""
    if REVISION.fullmatch(value) is None:
        raise ValueError(f"invalid git revision: {value!r}")
    return value


def changed_paths(before: str, after: str) -> list[str]:
    before = validated_revision(before)
    after = validated_revision(after)
    zero = "0" * 40
    command = (
        ["git", "ls-tree", "-r", "--name-only", after]
        if before == zero
        else ["git", "diff", "--name-only", before, after]
    )
    try:
        completed = subprocess.run(command, check=True, text=True, capture_output=True)
        return completed.stdout.splitlines()
    except subprocess.CalledProcessError:
        return ["__all_production_units__"]


def terraform_root(path: str) -> str | None:
    return next((root for root in TERRAFORM_ROOTS if path.startswith(f"{root}/")), None)


def select_terraform_path(path: str, selected: Selection) -> bool:
    if path.startswith(f"{TF_BOOTSTRAP}/"):
        reason = "terraform-bootstrap uses local bootstrap state and is never auto-applied"
        selected.manual.append(reason)
        selected.manual_unverified.append(reason)
        return True
    if path.startswith(f"{TF_IDENTITY_ADMIN}/"):
        selected.plan_roots.add(TF_IDENTITY_ADMIN)
        selected.manual_roots.add(TF_IDENTITY_ADMIN)
        selected.manual.append("the identity anchor is applied by hand; no pipeline identity may change the role that changes the identities")
        return True
    if path.startswith(f"{TF_GITHUB}/"):
        # Applied by the gated identity job, never by the deploy identity.
        selected.plan_roots.add(TF_GITHUB)
        selected.identity = True
        return True
    root = terraform_root(path)
    if root is None:
        return False
    selected.add_root(root)
    selected.web |= root in {TF_WEB, TF_ACCESS_API}
    return True


def select_workflow_path(path: str, selected: Selection) -> bool:
    root = WORKFLOW_ROOTS.get(path)
    if root is not None:
        selected.add_root(root)
        return True
    if path.startswith("workflows/"):
        selected.add_roots(ALL_WORKFLOW_ROOTS)
        return True
    return False


def select_other_path(path: str, selected: Selection) -> None:
    if path.startswith("server/"):
        selected.add_roots((TF_CORE, TF_RELEASES))
        if path == "server/user-data.sh":
            reason = "host user-data changes require a reviewed EC2 replacement or an explicit live-host rollout"
            selected.manual.append(reason)
            selected.manual_unverified.append(reason)
    if path in RELEASE_SCRIPTS:
        selected.add_root(TF_RELEASES)
    if path.startswith("infra/"):
        selected.roots.update(TERRAFORM_ROOTS)
        selected.plan_roots.update(ALL_PLAN_ROOTS)


def select_path(path: str, selected: Selection) -> None:
    # Prose deploys nothing: a README under a root is not that root.
    if path.endswith(".md"):
        return
    # Test fixtures never reach Terraform or the host either.
    if path.startswith("server/tests/"):
        return
    selected.web |= path.startswith("web/") or path == "scripts/deploy-web.sh"
    selected.lambdas |= path.startswith("lambdas/") or path == "scripts/deploy-lambdas.sh"
    if select_terraform_path(path, selected) or select_workflow_path(path, selected):
        return
    select_other_path(path, selected)


def make_plan(paths: list[str]) -> dict[str, object]:
    normalized = {Path(path).as_posix().removeprefix("./") for path in paths if path}
    deploy_all = "__all_production_units__" in normalized
    selected = Selection(
        roots=set(TERRAFORM_ROOTS if deploy_all else ()),
        plan_roots=set(ALL_PLAN_ROOTS if deploy_all else ()),
        web=deploy_all,
        lambdas=deploy_all,
    )
    if deploy_all:
        reason = "the previous commit is unavailable; refusing to infer a production diff"
        selected.manual.append(reason)
        selected.manual_unverified.append(reason)
    for path in normalized:
        select_path(path, selected)

    ordered_roots = [root for root in TERRAFORM_ROOTS if root in selected.roots]
    ordered_plan_roots = [root for root in ALL_PLAN_ROOTS if root in selected.plan_roots]
    return {
        "web": selected.web,
        "lambdas": selected.lambdas,
        "infrastructure": bool(ordered_roots),
        "identity": selected.identity,
        "terraform_roots": ordered_roots,
        "terraform_plan_roots": ordered_plan_roots,
        "manual_review": sorted(set(selected.manual)),
        "manual_terraform_roots": [root for root in PLAN_ONLY_TERRAFORM_ROOTS if root in selected.manual_roots],
        "manual_unverified": sorted(set(selected.manual_unverified)),
        "changed_paths": sorted(normalized),
    }


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: deployment_plan.py <before-sha> <after-sha>", file=sys.stderr)
        return 2
    try:
        plan = make_plan(changed_paths(sys.argv[1], sys.argv[2]))
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(plan, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
