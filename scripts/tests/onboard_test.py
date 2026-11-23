from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
ROOTS = ("terraform-bootstrap", "terraform-github", "terraform-identity-admin", "terraform-domain")

# Stubs record every call as one JSON line: argv, and stdin where a secret may travel.
AWS = r"""#!/usr/bin/env bash
printf '%s\n' "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@")" >> "$CALLS"
case "$1 $2" in
  "sts get-caller-identity")
    if [[ "$*" == *"--query Account"* ]]; then echo 123456789012; else
    echo '{"Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/admin"}'; fi ;;
  "s3api head-bucket") [[ -f "$STATE/bucket" ]] ;;
  "ssm get-parameter") exit 1 ;;
  "ssm put-parameter")
    for argument in "$@"; do
      if [[ "$argument" == file://* ]]; then cat "${argument#file://}" >> "$STATE/secrets"; printf '\n' >> "$STATE/secrets"; fi
    done ;;
esac
"""

GH = r"""#!/usr/bin/env bash
printf '%s\n' "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@")" >> "$CALLS"
case "$1 $2" in
  "auth status") ;;
  "repo view") echo '{"nameWithOwner":"example/spawnpoint","visibility":"PUBLIC","viewerPermission":"ADMIN"}' ;;
  "api user") echo 42 ;;
  "secret set") cat >> "$STATE/secrets"; printf '\n' >> "$STATE/secrets" ;;
  "api repos/example/spawnpoint/actions/oidc/customization/sub") echo true ;;
esac
"""

TERRAFORM = r"""#!/usr/bin/env bash
printf '%s\n' "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@")" >> "$CALLS"
for argument in "$@"; do
  case "$argument" in
    version) echo '{"terraform_version":"1.15.8"}'; exit 0 ;;
    apply) touch "$STATE/bucket"; exit 0 ;;
    show) echo '{"resource_changes":[{"change":{"actions":["create"]}}]}'; exit 0 ;;
    output)
      if [[ "$*" == *name_servers* ]]; then echo '["ns-1.example.net"]'; else echo "arn:aws:iam::123456789012:role/x"; fi
      exit 0 ;;
  esac
done
"""


class OnboardTest(unittest.TestCase):
    def setUp(self) -> None:
        self.work = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.work)
        # A copy of the repository's shape, so the backend files land in it.
        for script in ("onboard.sh", "write-backend-config.sh"):
            target = self.work / "repo/scripts" / script
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(REPOSITORY / "scripts" / script, target)
        for root in ROOTS:
            (self.work / "repo/infra" / root).mkdir(parents=True)
            if root != "terraform-bootstrap":
                (self.work / "repo/infra" / root / "backend.hcl.example").write_text(f'key = "spawnpoint/{root}.tfstate"\n')
        self.bin = self.work / "bin"
        self.bin.mkdir()
        for name, body in (("aws", AWS), ("gh", GH), ("terraform", TERRAFORM)):
            path = self.bin / name
            path.write_text(body)
            path.chmod(path.stat().st_mode | stat.S_IXUSR)
        self.state = self.work / "state"
        self.state.mkdir()
        self.calls = self.work / "calls.jsonl"

    def run_onboard(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        environment = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "CALLS": str(self.calls),
            "STATE": str(self.state),
            "SPAWNPOINT_DOMAIN": "Play.Example.com.",
            "SPAWNPOINT_ALERT_EMAIL": "alerts@example.com",
        }
        environment.pop("AWS_PROFILE", None)
        return subprocess.run(
            [os.environ.get("ONBOARD_BASH", "bash"), str(self.work / "repo/scripts/onboard.sh"), *arguments],
            env=environment, input="", text=True, capture_output=True, check=False,
        )

    def recorded(self) -> list[list[str]]:
        if not self.calls.exists():
            return []
        return [json.loads(line) for line in self.calls.read_text().splitlines()]

    def test_a_dry_run_reads_and_changes_nothing(self) -> None:
        result = self.run_onboard("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("would write /spawnpoint/auth/session-signing-secret", result.stdout)
        self.assertIn("would set secret TF_VAR_ALERT_EMAIL in production", result.stdout)
        for call in self.recorded():
            joined = " ".join(call)
            for verb in ("put-parameter", "variable set", "secret set", "--method PUT", " apply"):
                self.assertNotIn(verb, f" {joined}", joined)
        self.assertEqual(list((self.work / "repo/infra").glob("*/backend.hcl")), [])

    def test_a_run_writes_secrets_only_through_files_and_stdin(self) -> None:
        result = self.run_onboard("--yes")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.recorded()
        secrets = [line for line in (self.state / "secrets").read_text().splitlines() if line]
        self.assertIn("alerts@example.com", secrets)
        generated = [value for value in secrets if len(value) >= 32]
        self.assertGreaterEqual(len(generated), 3)
        for call in calls:
            for value in [*generated, "alerts@example.com"]:
                self.assertNotIn(value, call, "a secret reached a command line")
        puts = [call for call in calls if call[:2] == ["ssm", "put-parameter"]]
        self.assertTrue(puts)
        self.assertTrue(all("--no-overwrite" in call and "SecureString" in call for call in puts))

    def test_a_run_derives_names_and_configures_the_fork(self) -> None:
        result = self.run_onboard("--yes")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = [" ".join(call) for call in self.recorded()]
        self.assertIn("variable set TF_STATE_BUCKET --repo example/spawnpoint --body spawnpoint-tfstate-123456789012", calls)
        self.assertIn("variable set SPAWNPOINT_DOMAIN --repo example/spawnpoint --body play.example.com", calls)
        self.assertIn("variable set SPAWNPOINT_PLACEMENT --repo example/spawnpoint --body fleet", calls)
        self.assertIn("api --method PUT repos/example/spawnpoint/actions/permissions -F enabled=true -f allowed_actions=all", calls)
        self.assertTrue(any(call.startswith("api --method PUT repos/example/spawnpoint/environments/production-identity") for call in calls))
        backend = (self.work / "repo/infra/terraform-github/backend.hcl").read_text()
        self.assertIn('bucket       = "spawnpoint-tfstate-123456789012"', backend)
        self.assertIn('profile      = "default"', backend)
        self.assertIn("ns-1.example.net", result.stdout)

    def test_the_root_user_is_refused(self) -> None:
        aws = self.bin / "aws"
        aws.write_text(aws.read_text().replace("user/admin", "root"))
        result = self.run_onboard("--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("root user", result.stderr)


if __name__ == "__main__":
    unittest.main()
