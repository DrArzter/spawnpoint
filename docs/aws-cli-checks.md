# AWS CLI checks

Read-only commands used to verify the account bootstrap. They complement
[the console checklist](aws-account-checklist.md): the console teaches where a setting lives, while the API shows the
state AWS actually saved.

Nothing on this page creates, updates, publishes to or deletes an AWS resource. Run the complete audit with:

```bash
scripts/audit-aws-bootstrap.sh
```

Defaults are profile `spawnpoint`, resource region `eu-central-1`, budget API region `us-east-1`, budget
`20$/Month`, and topic `spawnpoint-alert`. Override any of them without editing the script:

```bash
AWS_PROFILE_NAME=spawnpoint \
AWS_RESOURCE_REGION=eu-central-1 \
AWS_BUDGET_NAME='20$/Month' \
AWS_TOPIC_NAME=spawnpoint-alert \
scripts/audit-aws-bootstrap.sh
```

## Authentication

The profile uses browser login and temporary credentials, not a long-lived IAM access key:

```bash
aws login --profile spawnpoint --region eu-central-1
aws sts get-caller-identity --profile spawnpoint
aws configure list --profile spawnpoint
```

`aws configure list` should report `login` as the credential type. `aws login` requires AWS CLI 2.32.0 or newer and
may need repeating when the temporary session expires. End it explicitly with:

```bash
aws logout --profile spawnpoint
```

## IAM user

First obtain the user name from `get-caller-identity`; do not hard-code an account ID in the repository:

```bash
SP_CALLER_ARN="$(aws sts get-caller-identity \
  --profile spawnpoint \
  --query Arn \
  --output text)"
SP_USER_NAME="${SP_CALLER_ARN##*/}"
```

Check that the human administrator has no long-lived access key, has MFA, and belongs to the intended group:

```bash
aws iam list-access-keys \
  --user-name "$SP_USER_NAME" \
  --profile spawnpoint

aws iam list-mfa-devices \
  --user-name "$SP_USER_NAME" \
  --profile spawnpoint

aws iam list-groups-for-user \
  --user-name "$SP_USER_NAME" \
  --profile spawnpoint
```

Expected: an empty `AccessKeyMetadata` array, at least one MFA device, and membership in `admin`.

## Budget and its recipients

The Budgets API needs the account ID even when the caller is already authenticated:

```bash
SP_ACCOUNT_ID="$(aws sts get-caller-identity \
  --profile spawnpoint \
  --query Account \
  --output text)"
```

Read the budget and its alert thresholds:

```bash
aws budgets describe-budget \
  --account-id "$SP_ACCOUNT_ID" \
  --budget-name '20$/Month' \
  --profile spawnpoint \
  --region us-east-1

aws budgets describe-notifications-for-budget \
  --account-id "$SP_ACCOUNT_ID" \
  --budget-name '20$/Month' \
  --profile spawnpoint \
  --region us-east-1
```

`HealthStatus: HEALTHY` proves that the budget itself is valid. It does **not** prove that alerts exist. An empty
`Notifications` array means the budget has no thresholds, even when the console shows it as healthy.

Check the recipient of one exact alert by passing back the three fields returned above:

```bash
aws budgets describe-subscribers-for-notification \
  --account-id "$SP_ACCOUNT_ID" \
  --budget-name '20$/Month' \
  --notification NotificationType=ACTUAL,ComparisonOperator=GREATER_THAN,Threshold=95 \
  --profile spawnpoint \
  --region us-east-1
```

Repeat with `NotificationType=FORECASTED` and `Threshold=80`. In the current design both should return one `SNS`
subscriber whose address ends in `:spawnpoint-alert`.

## SNS topic and email delivery

Build the ARN locally from non-secret identifiers:

```bash
SP_TOPIC_ARN="arn:aws:sns:eu-central-1:${SP_ACCOUNT_ID}:spawnpoint-alert"
```

Check confirmation counters, policy and the actual subscription records:

```bash
aws sns get-topic-attributes \
  --topic-arn "$SP_TOPIC_ARN" \
  --profile spawnpoint \
  --region eu-central-1

aws sns list-subscriptions-by-topic \
  --topic-arn "$SP_TOPIC_ARN" \
  --profile spawnpoint \
  --region eu-central-1
```

Expected: `SubscriptionsConfirmed` is at least one, `SubscriptionsPending` is zero, and the email subscription has a
real subscription ARN rather than `PendingConfirmation`.

The policy and subscription checks prove configuration. A manual SNS message proves delivery from SNS to email, but
not publication by AWS Budgets:

1. Open **Amazon SNS → Topics → `spawnpoint-alert`** in `eu-central-1`.
2. Choose **Publish message**.
3. Enter a subject and body, publish, and confirm that the email arrives.

That GUI action changes external state by delivering a message, so the audit script deliberately does not perform it.
AWS Budgets cannot be safely forced to cross a real threshold for a smoke test; its billing data normally refreshes
at least daily.
