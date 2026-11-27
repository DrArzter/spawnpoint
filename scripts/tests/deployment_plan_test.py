from __future__ import annotations

import re
import unittest
from pathlib import Path

from scripts.deployment_plan import BUNDLED_BY_LAMBDAS, BUNDLED_BY_WEB, make_plan, validated_revision

REPOSITORY = Path(__file__).resolve().parents[2]


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

    def test_readme_under_a_deployable_directory_deploys_and_plans_nothing(self) -> None:
        plan = make_plan(["infra/terraform/README.md", "web/README.md", "lambdas/README.md", "server/README.md"])
        self.assertFalse(plan["web"])
        self.assertFalse(plan["lambdas"])
        self.assertEqual(plan["terraform_roots"], [])
        self.assertEqual(plan["terraform_plan_roots"], [])
        self.assertEqual(plan["manual_review"], [])

    def test_server_test_change_deploys_and_plans_nothing(self) -> None:
        plan = make_plan(["server/tests/terraform-safety-test.sh", "server/tests/fake-aws"])
        self.assertEqual(plan["terraform_roots"], [])
        self.assertEqual(plan["terraform_plan_roots"], [])
        self.assertEqual(plan["manual_review"], [])

    def test_a_shared_contract_change_deploys_both_bundles(self) -> None:
        plan = make_plan(["contract/operations.ts"])
        self.assertTrue(plan["web"])
        self.assertTrue(plan["lambdas"])

    def test_a_file_a_lambda_bundles_from_the_host_tree_deploys_the_lambdas(self) -> None:
        for path in ("server/games/minecraft/settings.json", "server/scripts/host-output.json"):
            with self.subTest(path=path):
                self.assertTrue(make_plan([path])["lambdas"])

    def test_every_import_from_outside_a_bundle_has_a_rule(self) -> None:
        pattern = re.compile(r"""from ["']((?:\.\./)+[^"']+)["']""")
        for tree, prefixes in (("lambdas/src", BUNDLED_BY_LAMBDAS), ("web/src", BUNDLED_BY_WEB)):
            bundle = REPOSITORY / tree.split("/")[0]
            for source in (REPOSITORY / tree).rglob("*.ts*"):
                for specifier in pattern.findall(source.read_text(encoding="utf-8")):
                    target = (source.parent / specifier).resolve()
                    if target.is_relative_to(bundle):
                        continue
                    relative = target.relative_to(REPOSITORY).as_posix()
                    with self.subTest(source=str(source.relative_to(REPOSITORY)), target=relative):
                        self.assertTrue(relative.startswith(prefixes), f"{relative} is bundled by {tree} but deploys nothing when it changes")

    def test_web_change_deploys_only_web(self) -> None:
        plan = make_plan(["web/src/App.tsx"])
        self.assertTrue(plan["web"])
        self.assertFalse(plan["lambdas"])
        self.assertEqual(plan["terraform_roots"], [])

    def test_lambda_code_also_applies_the_roots_that_package_lambdas(self) -> None:
        # 2026-11-27: a fix in spot-interruption.ts deployed only the Lambda job,
        # which does not know that function; the old code ran the next fault test.
        plan = make_plan(["lambdas/src/control-plane/spot-interruption.ts"])
        self.assertTrue(plan["lambdas"])
        self.assertFalse(plan["web"])
        self.assertEqual(
            sorted(plan["terraform_roots"]),
            sorted(["infra/terraform-operations", "infra/terraform-access-api", "infra/terraform-releases"]),
        )

    def test_a_lambda_test_change_applies_no_root(self) -> None:
        plan = make_plan(["lambdas/test/spot-interruption.test.ts"])
        self.assertTrue(plan["lambdas"])
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
        self.assertEqual(plan["terraform_roots"], ["infra/terraform", "infra/terraform-releases", "infra/terraform-access-api"])
        self.assertTrue(plan["manual_review"])

    def test_host_code_change_moves_the_commit_hosts_check_out(self) -> None:
        # ADR-0067: the access API root writes the commit a host updates to.
        plan = make_plan(["server/scripts/start-session.sh"])
        self.assertIn("infra/terraform-access-api", plan["terraform_roots"])
        self.assertFalse(plan["web"])
        self.assertFalse(plan["lambdas"])

    def test_bootstrap_change_requires_manual_review(self) -> None:
        plan = make_plan(["infra/terraform-bootstrap/main.tf"])
        self.assertFalse(plan["infrastructure"])
        self.assertEqual(plan["terraform_plan_roots"], [])
        self.assertEqual(plan["manual_terraform_roots"], [])
        self.assertTrue(plan["manual_review"])
        self.assertTrue(plan["manual_unverified"])

    def test_github_identity_change_is_applied_by_the_gated_identity_job(self) -> None:
        plan = make_plan(["infra/terraform-github/main.tf"])
        self.assertTrue(plan["identity"])
        self.assertFalse(plan["infrastructure"])
        self.assertEqual(plan["terraform_roots"], [])
        self.assertEqual(plan["terraform_plan_roots"], ["infra/terraform-github"])
        self.assertEqual(plan["manual_terraform_roots"], [])
        self.assertEqual(plan["manual_review"], [])

    def test_identity_anchor_change_requires_a_hand_apply(self) -> None:
        plan = make_plan(["infra/terraform-identity-admin/main.tf"])
        self.assertFalse(plan["identity"])
        self.assertFalse(plan["infrastructure"])
        self.assertEqual(plan["terraform_plan_roots"], ["infra/terraform-identity-admin"])
        self.assertEqual(plan["manual_terraform_roots"], ["infra/terraform-identity-admin"])
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

    def test_domain_root_is_planned_and_deployed_before_service_roots(self) -> None:
        plan = make_plan(["infra/terraform-web/web.tf", "infra/terraform-domain/domain.tf"])
        self.assertEqual(plan["terraform_roots"], ["infra/terraform-domain", "infra/terraform-web"])
        self.assertEqual(plan["terraform_plan_roots"], ["infra/terraform-domain", "infra/terraform-web"])


if __name__ == "__main__":
    unittest.main()
