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

    def test_pull_request_plan_role_is_read_only_and_environment_scoped(self) -> None:
        terraform = (REPOSITORY / "infra/terraform-github/main.tf").read_text()
        plan_policy = terraform.split('data "aws_iam_policy_document" "github_plan_iam"', 1)[1]
        self.assertIn("environment:production-plan", terraform)
        self.assertNotIn('"s3:PutObject"', plan_policy)
        self.assertNotIn('"s3:DeleteObject"', plan_policy)
        self.assertNotIn('"iam:PassRole"', plan_policy)

    def test_automatic_terraform_refuses_delete_and_replacement_plans(self) -> None:
        script = (REPOSITORY / "scripts/terraform-apply-safe.sh").read_text()
        self.assertIn('index("delete")', script)
        self.assertIn("automatic apply refused", script)

    def test_pull_request_plan_never_applies_and_refuses_destructive_changes(self) -> None:
        script = (REPOSITORY / "scripts/terraform-plan-safe.sh").read_text()
        self.assertNotIn('terraform -chdir="${root_path}" apply', script)
        self.assertIn('-lock=false', script)
        self.assertIn('index("delete")', script)
        self.assertIn("pull request plan refused", script)
        self.assertIn("result=destructive", script)

    def test_pull_request_comments_only_update_the_actions_bot_own_marker(self) -> None:
        script = (REPOSITORY / "scripts/upsert-pr-comment.sh").read_text()
        self.assertIn('user.login == "github-actions[bot]"', script)
        self.assertIn("contains($marker)", script)
        self.assertIn("issues/comments/${comment_id}", script)


if __name__ == "__main__":
    unittest.main()
