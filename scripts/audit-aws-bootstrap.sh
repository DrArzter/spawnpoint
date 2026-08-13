#!/usr/bin/env bash

set -euo pipefail

AWS_PROFILE_NAME="${AWS_PROFILE_NAME:-spawnpoint}"
AWS_RESOURCE_REGION="${AWS_RESOURCE_REGION:-eu-central-1}"
AWS_BUDGET_API_REGION="${AWS_BUDGET_API_REGION:-us-east-1}"
AWS_BUDGET_NAME="${AWS_BUDGET_NAME:-20$/Month}"
AWS_TOPIC_NAME="${AWS_TOPIC_NAME:-spawnpoint-alert}"

command -v aws >/dev/null || {
  echo "error: aws CLI is not installed" >&2
  exit 1
}

SP_ACCOUNT_ID="$(aws sts get-caller-identity \
  --profile "$AWS_PROFILE_NAME" \
  --query Account \
  --output text)"

SP_CALLER_ARN="$(aws sts get-caller-identity \
  --profile "$AWS_PROFILE_NAME" \
  --query Arn \
  --output text)"

case "$SP_CALLER_ARN" in
  arn:aws:iam::*:user/*)
    SP_USER_NAME="${SP_CALLER_ARN##*/}"
    ;;
  *)
    echo "error: expected an IAM user login, got $SP_CALLER_ARN" >&2
    exit 1
    ;;
esac

SP_TOPIC_ARN="arn:aws:sns:${AWS_RESOURCE_REGION}:${SP_ACCOUNT_ID}:${AWS_TOPIC_NAME}"

printf '\nIdentity\n'
aws sts get-caller-identity \
  --profile "$AWS_PROFILE_NAME" \
  --no-cli-pager

printf '\nIAM access keys (expected: empty)\n'
aws iam list-access-keys \
  --user-name "$SP_USER_NAME" \
  --profile "$AWS_PROFILE_NAME" \
  --no-cli-pager

printf '\nIAM MFA devices (expected: one or more)\n'
aws iam list-mfa-devices \
  --user-name "$SP_USER_NAME" \
  --profile "$AWS_PROFILE_NAME" \
  --no-cli-pager

printf '\nIAM groups\n'
aws iam list-groups-for-user \
  --user-name "$SP_USER_NAME" \
  --profile "$AWS_PROFILE_NAME" \
  --no-cli-pager

printf '\nBudget\n'
aws budgets describe-budget \
  --account-id "$SP_ACCOUNT_ID" \
  --budget-name "$AWS_BUDGET_NAME" \
  --profile "$AWS_PROFILE_NAME" \
  --region "$AWS_BUDGET_API_REGION" \
  --no-cli-pager

printf '\nBudget notifications\n'
aws budgets describe-notifications-for-budget \
  --account-id "$SP_ACCOUNT_ID" \
  --budget-name "$AWS_BUDGET_NAME" \
  --profile "$AWS_PROFILE_NAME" \
  --region "$AWS_BUDGET_API_REGION" \
  --no-cli-pager

while IFS=$'\t' read -r SP_NOTIFICATION_TYPE SP_COMPARISON_OPERATOR SP_THRESHOLD; do
  printf '\nSubscribers for %s %s %s\n' \
    "$SP_NOTIFICATION_TYPE" \
    "$SP_COMPARISON_OPERATOR" \
    "$SP_THRESHOLD"

  aws budgets describe-subscribers-for-notification \
    --account-id "$SP_ACCOUNT_ID" \
    --budget-name "$AWS_BUDGET_NAME" \
    --notification \
      "NotificationType=${SP_NOTIFICATION_TYPE},ComparisonOperator=${SP_COMPARISON_OPERATOR},Threshold=${SP_THRESHOLD}" \
    --profile "$AWS_PROFILE_NAME" \
    --region "$AWS_BUDGET_API_REGION" \
    --no-cli-pager
done < <(
  aws budgets describe-notifications-for-budget \
    --account-id "$SP_ACCOUNT_ID" \
    --budget-name "$AWS_BUDGET_NAME" \
    --profile "$AWS_PROFILE_NAME" \
    --region "$AWS_BUDGET_API_REGION" \
    --query 'Notifications[].[NotificationType,ComparisonOperator,Threshold]' \
    --output text
)

printf '\nSNS delivery counters and policy\n'
aws sns get-topic-attributes \
  --topic-arn "$SP_TOPIC_ARN" \
  --profile "$AWS_PROFILE_NAME" \
  --region "$AWS_RESOURCE_REGION" \
  --query '{confirmed:Attributes.SubscriptionsConfirmed,pending:Attributes.SubscriptionsPending,policy:Attributes.Policy}' \
  --no-cli-pager

printf '\nSNS subscriptions\n'
aws sns list-subscriptions-by-topic \
  --topic-arn "$SP_TOPIC_ARN" \
  --profile "$AWS_PROFILE_NAME" \
  --region "$AWS_RESOURCE_REGION" \
  --no-cli-pager
