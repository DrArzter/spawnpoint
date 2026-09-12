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
        self.assertIn('source "${repository_root}/scripts/_terraform-destroy-allow.sh"', script)
        self.assertIn("assess_destroys", script)
        self.assertIn("automatic apply refused", script)

    def test_pull_request_plan_never_applies_and_refuses_destructive_changes(self) -> None:
        script = (REPOSITORY / "scripts/terraform-plan-safe.sh").read_text()
        self.assertNotIn('terraform -chdir="${root_path}" apply', script)
        self.assertIn('-lock=false', script)
        self.assertIn('source "${repository_root}/scripts/_terraform-destroy-allow.sh"', script)
        self.assertIn("pull request plan refused", script)
        self.assertIn("result=destructive", script)

    def test_destroy_allow_list_covers_only_types_the_deploy_role_may_delete(self) -> None:
        library = (REPOSITORY / "scripts/_terraform-destroy-allow.sh").read_text()
        terraform = (REPOSITORY / "infra/terraform-github/main.tf").read_text()
        self.assertIn('index("delete")', library)
        self.assertIn("destroy-allowed.txt", library)
        listed_types = library.split("DESTROY_DELETABLE_TYPES=(", 1)[1].split(")", 1)[0].split()
        delete_action_for_type = {
            "aws_apigatewayv2_integration": '"apigateway:DELETE"',
            "aws_apigatewayv2_route": '"apigateway:DELETE"',
            "aws_cloudwatch_event_rule": '"events:DeleteRule"',
            "aws_cloudwatch_event_target": '"events:RemoveTargets"',
            "aws_cloudwatch_log_group": '"logs:DeleteLogGroup"',
            "aws_cloudwatch_metric_alarm": '"cloudwatch:DeleteAlarms"',
            "aws_codebuild_project": '"codebuild:DeleteProject"',
            "aws_iam_role": '"iam:DeleteRole"',
            "aws_iam_role_policy": '"iam:DeleteRolePolicy"',
            "aws_iam_role_policy_attachment": '"iam:DetachRolePolicy"',
            "aws_lambda_permission": '"lambda:RemovePermission"',
            "aws_sfn_state_machine": '"states:DeleteStateMachine"',
            "aws_sns_topic_subscription": '"sns:Unsubscribe"',
        }
        self.assertEqual(sorted(listed_types), sorted(delete_action_for_type))
        for action in set(delete_action_for_type.values()):
            self.assertIn(action, terraform)
        for never_granted in (
            '"ec2:TerminateInstances"', '"ec2:DeleteVolume"', '"s3:DeleteBucket"', '"dynamodb:DeleteTable"',
            '"iam:DeleteOpenIDConnectProvider"', '"cloudfront:DeleteDistribution"', '"lambda:DeleteFunction"',
            '"lambda:DeleteFunctionUrlConfig"', '"budgets:DeleteBudget"', '"sns:DeleteTopic"',
        ):
            self.assertNotIn(never_granted, terraform)

    def test_manual_root_verification_requires_an_empty_read_only_plan(self) -> None:
        script = (REPOSITORY / "scripts/terraform-verify-applied.sh").read_text()
        self.assertNotIn('terraform -chdir="${root_path}" apply', script)
        self.assertIn('-lock=false', script)
        self.assertIn('actions != ["no-op"]', script)
        self.assertIn("pending-manual-apply", script)

        workflow = (REPOSITORY / ".github/workflows/deploy-production.yml").read_text()
        manual_job = workflow.split("  manual-review:", 1)[1].split("\n  infrastructure:", 1)[0]
        self.assertIn("environment: production-plan", manual_job)
        self.assertIn("role-to-assume: ${{ vars.AWS_PLAN_ROLE_ARN }}", manual_job)
        self.assertNotIn("AWS_DEPLOY_ROLE_ARN", manual_job)
        self.assertIn("manual_unverified", manual_job)
        self.assertNotIn("run: jq -r", manual_job)

    def test_pull_request_comments_only_update_the_actions_bot_own_marker(self) -> None:
        script = (REPOSITORY / "scripts/upsert-pr-comment.sh").read_text()
        self.assertIn('user.login == "github-actions[bot]"', script)
        self.assertIn("contains($marker)", script)
        self.assertIn("issues/comments/${comment_id}", script)


if __name__ == "__main__":
    unittest.main()
