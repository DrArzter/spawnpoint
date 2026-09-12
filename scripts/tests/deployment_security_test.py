from __future__ import annotations

import unittest
from pathlib import Path


REPOSITORY = Path(__file__).resolve().parents[2]


class DeploymentSecurityTest(unittest.TestCase):
    def test_deployment_role_has_no_broad_managed_policy(self) -> None:
        terraform = (REPOSITORY / "infra/terraform-github/main.tf").read_text()
        self.assertNotIn("PowerUserAccess", terraform)
        self.assertNotIn('resource "aws_iam_role_policy_attachment" "github_deploy', terraform)
        self.assertIn("NeverMutateOwnDeploymentIdentity", terraform)

    def test_automatic_terraform_refuses_delete_and_replacement_plans(self) -> None:
        script = (REPOSITORY / "scripts/terraform-apply-safe.sh").read_text()
        self.assertIn('index("delete")', script)
        self.assertIn("automatic apply refused", script)


if __name__ == "__main__":
    unittest.main()
