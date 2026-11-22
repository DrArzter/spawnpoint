# The host may observe a world's desired/active pointer during boot-time
# reconciliation. It cannot create, change or delete pointers; adoption and
# promotion remain control-plane operations.
data "aws_iam_policy_document" "game_host_world_pointers" {
  statement {
    sid       = "ReadWorldReleasePointers"
    actions   = ["s3:GetObject"]
    resources = ["${data.aws_s3_bucket.releases.arn}/worlds/*"]
  }
}

resource "aws_iam_role_policy" "game_host_world_pointers" {
  name   = "spawnpoint-game-host-world-pointers"
  role   = "spawnpoint-game-host"
  policy = data.aws_iam_policy_document.game_host_world_pointers.json
}

# A new backup holds its release (ADR-0080): the host writes one holder item and
# adds one to the release's count, right after the upload. Release items only:
# the leading key keeps file items out of reach. IAM cannot limit the sort key or
# require a live release, so hold-backup-release.sh checks both with a condition.
# Nothing here deletes, and the host cannot scan or list the table.
data "aws_iam_policy_document" "game_host_backup_holders" {
  statement {
    sid       = "HoldReleaseForBackup"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [local.release_state_refs_table_arn]
    condition {
      test     = "ForAllValues:StringLike"
      variable = "dynamodb:LeadingKeys"
      values   = ["release#*"]
    }
  }
}

resource "aws_iam_role_policy" "game_host_backup_holders" {
  name   = "spawnpoint-game-host-backup-holders"
  role   = "spawnpoint-game-host"
  policy = data.aws_iam_policy_document.game_host_backup_holders.json
}
