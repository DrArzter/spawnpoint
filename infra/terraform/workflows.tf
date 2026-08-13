data "aws_iam_policy_document" "step_functions_assume_role" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "aws:SourceAccount"
      values   = [data.aws_caller_identity.current.account_id]
    }

    condition {
      test     = "ArnLike"
      variable = "aws:SourceArn"
      values   = ["arn:aws:states:${var.aws_region}:${data.aws_caller_identity.current.account_id}:stateMachine:spawnpoint-*"]
    }
  }
}

resource "aws_iam_role" "start_workflow" {
  name               = "spawnpoint-start-workflow"
  assume_role_policy = data.aws_iam_policy_document.step_functions_assume_role.json

  tags = {
    Name = "spawnpoint-start-workflow"
  }
}

data "aws_iam_policy_document" "start_workflow" {
  statement {
    sid = "ReadHostState"

    actions = [
      "ec2:DescribeInstances",
      "ssm:DescribeInstanceInformation",
      "ssm:GetCommandInvocation",
    ]
    resources = ["*"]
  }

  statement {
    sid       = "StartOnlySpawnpointHost"
    actions   = ["ec2:StartInstances"]
    resources = [aws_instance.game_host.arn]
  }

  statement {
    sid     = "RunOnlyApprovedDocumentOnSpawnpointHost"
    actions = ["ssm:SendCommand"]
    resources = [
      aws_instance.game_host.arn,
      "arn:aws:ssm:${var.aws_region}::document/AWS-RunShellScript",
    ]
  }
}

resource "aws_iam_role_policy" "start_workflow" {
  name   = "spawnpoint-start-workflow"
  role   = aws_iam_role.start_workflow.id
  policy = data.aws_iam_policy_document.start_workflow.json
}

resource "aws_sfn_state_machine" "start_server" {
  name       = "spawnpoint-start-server"
  role_arn   = aws_iam_role.start_workflow.arn
  type       = "STANDARD"
  definition = file("${path.module}/../../workflows/start-server.asl.json")

  tags = {
    Name    = "spawnpoint-start-server"
    Purpose = "on-demand-session-start"
  }
}
