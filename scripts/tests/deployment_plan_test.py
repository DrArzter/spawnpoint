from __future__ import annotations

import unittest

from scripts.deployment_plan import make_plan, validated_revision


class DeploymentPlanTest(unittest.TestCase):
    def test_git_revisions_accept_only_full_lowercase_object_ids(self) -> None:
        revision = "a" * 40
        self.assertEqual(validated_revision(revision), revision)
        for invalid in ("main", "--output=/tmp/leak", "A" * 40, "a" * 39):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                validated_revision(invalid)

    def test_documentation_change_deploys_nothing(self) -> None:
        plan = make_plan(["docs/roadmap.md"])
        self.assertFalse(plan["web"])
        self.assertFalse(plan["lambdas"])
        self.assertFalse(plan["infrastructure"])

    def test_web_change_deploys_only_web(self) -> None:
        plan = make_plan(["web/src/App.tsx"])
        self.assertTrue(plan["web"])
        self.assertFalse(plan["lambdas"])
        self.assertEqual(plan["terraform_roots"], [])

    def test_lambda_change_deploys_only_lambda_pipeline(self) -> None:
        plan = make_plan(["lambdas/src/handlers/access-api.ts"])
        self.assertTrue(plan["lambdas"])
        self.assertFalse(plan["web"])
        self.assertEqual(plan["terraform_roots"], [])

    def test_root_change_selects_only_that_root(self) -> None:
        plan = make_plan(["infra/terraform-operations/workflows.tf"])
        self.assertEqual(plan["terraform_roots"], ["infra/terraform-operations"])

    def test_access_api_infrastructure_also_rebuilds_web_configuration(self) -> None:
        plan = make_plan(["infra/terraform-access-api/outputs.tf"])
        self.assertTrue(plan["web"])
        self.assertEqual(plan["terraform_roots"], ["infra/terraform-access-api"])

    def test_host_bootstrap_payload_is_never_reported_as_fully_automatic(self) -> None:
        plan = make_plan(["server/user-data.sh"])
        self.assertEqual(plan["terraform_roots"], ["infra/terraform", "infra/terraform-releases"])
        self.assertTrue(plan["manual_review"])

    def test_bootstrap_change_requires_manual_review(self) -> None:
        plan = make_plan(["infra/terraform-bootstrap/main.tf"])
        self.assertFalse(plan["infrastructure"])
        self.assertEqual(plan["terraform_plan_roots"], [])
        self.assertEqual(plan["manual_terraform_roots"], [])
        self.assertTrue(plan["manual_review"])
        self.assertTrue(plan["manual_unverified"])

    def test_deployment_identity_change_requires_manual_review(self) -> None:
        plan = make_plan(["infra/terraform-github/main.tf"])
        self.assertFalse(plan["infrastructure"])
        self.assertEqual(plan["terraform_plan_roots"], ["infra/terraform-github"])
        self.assertEqual(plan["manual_terraform_roots"], ["infra/terraform-github"])
        self.assertTrue(plan["manual_review"])
        self.assertEqual(plan["manual_unverified"], [])

    def test_host_bootstrap_payload_cannot_be_verified_by_the_deployment_role(self) -> None:
        plan = make_plan(["server/user-data.sh"])
        self.assertTrue(plan["manual_unverified"])
        self.assertEqual(plan["manual_terraform_roots"], [])

    def test_regular_terraform_root_is_both_planned_and_deployed(self) -> None:
        plan = make_plan(["infra/terraform-storage/storage.tf"])
        self.assertEqual(plan["terraform_roots"], ["infra/terraform-storage"])
        self.assertEqual(plan["terraform_plan_roots"], ["infra/terraform-storage"])


if __name__ == "__main__":
    unittest.main()
