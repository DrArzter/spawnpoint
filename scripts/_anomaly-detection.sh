#!/usr/bin/env bash
# Sourced by the CI Terraform scripts after init. Decides whether the
# guardrails root manages cost anomaly detection, which needs Cost Explorer:
# a new account has none for up to a day, and creating a monitor then fails.
#
# SPAWNPOINT_ANOMALY_DETECTION=true|false decides it outright. Unset, a
# monitor already in state stays, so a failed probe never plans its removal;
# otherwise it is on once Cost Explorer answers.

decide_anomaly_detection() {
  local root="$1" root_path="$2"
  [[ "${root}" == "infra/terraform-guardrails" ]] || return 0

  case "${SPAWNPOINT_ANOMALY_DETECTION:-}" in
    true | false)
      TF_VAR_enable_anomaly_detection="${SPAWNPOINT_ANOMALY_DETECTION}"
      ;;
    "")
      if terraform -chdir="${root_path}" state list 2>/dev/null | grep -qxF 'aws_ce_anomaly_monitor.services[0]'; then
        TF_VAR_enable_anomaly_detection=true
      elif aws ce get-anomaly-monitors --max-results 1 >/dev/null 2>&1; then
        TF_VAR_enable_anomaly_detection=true
      else
        printf '::warning::Cost Explorer is not ready in this account yet; anomaly detection waits for a later deploy\n' >&2
        TF_VAR_enable_anomaly_detection=false
      fi
      ;;
    *)
      printf 'error: SPAWNPOINT_ANOMALY_DETECTION must be true, false or unset\n' >&2
      return 1
      ;;
  esac
  export TF_VAR_enable_anomaly_detection
}
