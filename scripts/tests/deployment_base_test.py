from __future__ import annotations

import sys
import unittest
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY / "scripts"))

from deployment_base import choose_base, last_deployed  # noqa: E402

# A linear main: a, then b, then c.
A, B, C, OTHER = "a" * 40, "b" * 40, "c" * 40, "d" * 40
HISTORY = [A, B, C]


def is_ancestor(ancestor: str, descendant: str) -> bool:
    if ancestor not in HISTORY or descendant not in HISTORY:
        return False
    return HISTORY.index(ancestor) <= HISTORY.index(descendant)


def base(titles: list[str], head: str) -> str:
    return choose_base(titles, head, is_ancestor, first_base=A, main=C)[0]


class DeploymentBaseTest(unittest.TestCase):
    def test_a_deploy_carries_every_change_since_the_last_successful_deploy(self) -> None:
        # b was merged and its deploy never ran; c's deploy carries b as well.
        self.assertEqual(base([f"Deploy production {A}"], C), A)

    def test_the_newest_titled_run_is_the_deployed_revision(self) -> None:
        titles = ["Deploy production", f"Deploy production {B}", f"Deploy production {A}"]
        self.assertEqual(last_deployed(titles), B)
        self.assertEqual(base(titles, C), B)

    def test_a_rerun_of_an_older_deploy_deploys_nothing(self) -> None:
        self.assertEqual(base([f"Deploy production {C}"], B), B)
        self.assertEqual(base([f"Deploy production {C}"], C), C)

    def test_without_a_titled_run_the_first_base_is_the_base(self) -> None:
        self.assertEqual(base(["Deploy production"], C), A)

    def test_a_deployed_revision_outside_the_history_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            base([f"Deploy production {OTHER}"], C)

    def test_a_commit_that_is_not_on_main_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            base([f"Deploy production {A}"], OTHER)

    def test_only_a_full_revision_is_accepted_as_head(self) -> None:
        with self.assertRaises(ValueError):
            base([f"Deploy production {A}"], "main")

    def test_the_workflow_names_each_run_after_the_revision_it_deploys(self) -> None:
        workflow = (REPOSITORY / ".github/workflows/deploy-production.yml").read_text()
        self.assertIn("run-name: Deploy production ${{ github.event.workflow_run.head_sha }}", workflow)
        self.assertIn("status=success", workflow)
        self.assertIn("scripts/deployment_base.py", workflow)
        # Scripts run from main, never from the commit that triggered the run.
        plan_job = workflow.split("\n  plan:\n", 1)[1].split("\n  manual-review:", 1)[0]
        self.assertIn("ref: main", plan_job)
        self.assertNotIn("ref: ${{ github.event.workflow_run.head_sha }}", plan_job)


if __name__ == "__main__":
    unittest.main()
