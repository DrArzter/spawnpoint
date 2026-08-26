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
