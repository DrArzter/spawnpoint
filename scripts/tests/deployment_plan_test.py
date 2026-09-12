from __future__ import annotations

import unittest

from scripts.deployment_plan import make_plan


class DeploymentPlanTest(unittest.TestCase):
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
        self.assertTrue(plan["manual_review"])

    def test_deployment_identity_change_requires_manual_review(self) -> None:
        plan = make_plan(["infra/terraform-github/main.tf"])
        self.assertFalse(plan["infrastructure"])
        self.assertTrue(plan["manual_review"])


if __name__ == "__main__":
    unittest.main()
