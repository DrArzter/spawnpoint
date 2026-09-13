#!/usr/bin/env python3
"""Hygiene checks for test and production GitHub Actions workflows."""

from __future__ import annotations

import re
import sys
import textwrap
from pathlib import Path

WORKFLOWS = Path(__file__).resolve().parent.parent / ".github" / "workflows"
PINNED = re.compile(r"uses:\s*([\w.-]+/[\w.-]+)@([0-9a-f]{40})\s+#\s*v")
USES = re.compile(r"uses:\s*(\S+)")
DUPLICATED = ("terraform test", "npm test", "apk add", "shellcheck -x")


def permission_scopes(text: str) -> dict[str, str]:
    lines = text.splitlines()
    try:
        start = lines.index("permissions:") + 1
    except ValueError:
        return {}
    scopes: dict[str, str] = {}
    for line in lines[start:]:
        match = re.fullmatch(r" {2}([\w-]+):\s*(\S+)", line)
        if match is None:
            break
        scopes[match.group(1)] = match.group(2)
    return scopes


def job_permission_scopes(text: str, job_name: str) -> dict[str, str]:
    match = re.search(
        rf"(?ms)^  {re.escape(job_name)}:\n(.*?)(?=^  [\w-]+:\n|\Z)",
        text,
    )
    if match is None:
        return {}
    return permission_scopes(textwrap.dedent(match.group(1)))


def check_action_pins(text: str) -> list[str]:
    problems: list[str] = []
    for line in text.splitlines():
        match = USES.search(line)
        if match is None or match.group(1).startswith("./"):
            continue
        if not PINNED.search(line):
            problems.append(f"{match.group(1)} is not pinned to a 40-character commit with a version comment")
    return problems


def check_test_workflow(text: str) -> list[str]:
    problems: list[str] = []
    scopes = permission_scopes(text)
    expected = {"contents": "read"}
    if scopes != expected:
        problems.append(f"check permissions must be {expected}, found {scopes}")
    aggregate_scopes = job_permission_scopes(text, "check")
    expected_aggregate = {"contents": "read", "pull-requests": "write"}
    if aggregate_scopes != expected_aggregate:
        problems.append(
            f"aggregate check permissions must be {expected_aggregate}, found {aggregate_scopes}"
        )
    if text.count("pull-requests: write") != 1:
        problems.append("pull request write access must be granted only to the aggregate check job")
    for forbidden, reason in (
        ("id-token", "OIDC would give the check a cloud identity"),
        ("aws-actions/", "an AWS action means cloud credentials"),
        ("${{ secrets.", "a check needs no secret"),
    ):
        if forbidden in text:
            problems.append(f"{forbidden} is present — {reason}")
    if "scripts/check.sh" not in text:
        problems.append("does not run scripts/check.sh, so it cannot be the same ladder a developer runs")
    if "scripts/upsert-pr-comment.sh" not in text or "spawnpoint-tests-summary" not in text:
        problems.append("does not publish a stable pull request test summary")
    for duplicated in DUPLICATED:
        if duplicated in text:
            problems.append(f"runs {duplicated!r} directly instead of through scripts/check.sh")
    return problems


def check_production_gate(text: str) -> list[str]:
    problems: list[str] = []
    required_fragments = (
        "workflow_run:",
        "workflows: [Check]",
        "github.event.workflow_run.conclusion == 'success'",
        "      actions: read\n      contents: read",
        "      contents: read\n      id-token: write",
    )
    for required in required_fragments:
        if required not in text:
            problems.append(f"production gate is missing {required!r}")
    return problems


def check_deploy_unit(text: str) -> list[str]:
    problems: list[str] = []
    expected = {"contents": "read", "id-token": "write"}
    scopes = permission_scopes(text)
    if scopes != expected:
        problems.append(f"deploy permissions must be {expected}, found {scopes}")
    if "workflow_call:" not in text:
        problems.append("a deploy unit must be callable only by the production gate")
    if "environment:" not in text or "production" not in text:
        problems.append("a cloud deploy unit must use the production environment")
    return problems


def check_deploy_workflow(path: Path, text: str) -> list[str]:
    problems = check_production_gate(text) if path.name == "deploy-production.yml" else check_deploy_unit(text)
    if path.name == "deploy-production.yml" and permission_scopes(text):
        problems.append("the production gate must grant permissions per job, not at workflow level")
    if "pull_request:" in text or "push:" in text:
        problems.append("deploy workflow bypasses the successful Check workflow_run gate")
    return problems


def check_plan_workflow(text: str) -> list[str]:
    problems: list[str] = []
    scopes = permission_scopes(text)
    expected = {"contents": "read", "id-token": "write", "pull-requests": "write"}
    if scopes != expected:
        problems.append(f"plan permissions must be {expected}, found {scopes}")
    for required in (
        "pull_request:",
        "branches: [main]",
        "environment: production-plan",
        "scripts/terraform-plan-safe.sh",
        "AWS_PLAN_ROLE_ARN",
        "scripts/upsert-pr-comment.sh",
        "spawnpoint-terraform-summary",
    ):
        if required not in text:
            problems.append(f"pull request plan gate is missing {required!r}")
    for forbidden in ("terraform apply", "AWS_DEPLOY_ROLE_ARN", "push:", "workflow_run:"):
        if forbidden in text:
            problems.append(f"pull request plan contains forbidden production capability {forbidden!r}")
    return problems


def check(path: Path) -> list[str]:
    text = path.read_text()
    problems = check_action_pins(text)
    if path.name == "check.yml":
        problems.extend(check_test_workflow(text))
    elif path.name == "terraform-plan.yml":
        problems.extend(check_plan_workflow(text))
    elif path.name.startswith("deploy-"):
        problems.extend(check_deploy_workflow(path, text))
    else:
        problems.append("workflow is neither the check nor a reviewed deploy unit")
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
