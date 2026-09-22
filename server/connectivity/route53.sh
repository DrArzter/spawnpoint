#!/usr/bin/env bash

route53_configure() {
  local suffix
  CONNECTIVITY_ZONE_ID="${SPAWNPOINT_DNS_ZONE_ID:-$(read_env_value SPAWNPOINT_DNS_ZONE_ID)}"
  suffix="${SPAWNPOINT_DNS_SUFFIX:-$(read_env_value SPAWNPOINT_DNS_SUFFIX)}"
  [[ "${CONNECTIVITY_ZONE_ID}" =~ ^Z[A-Z0-9]+$ ]] || { printf 'error: invalid Route 53 zone ID\n' >&2; return 1; }
  [[ "${suffix}" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || { printf 'error: invalid DNS suffix\n' >&2; return 1; }
  [[ "${WORLD_ID:-}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { printf 'error: Route 53 requires a world ID\n' >&2; return 1; }
  CONNECTIVITY_HOST="${WORLD_ID}.${suffix}"
}

connectivity_prepare() {
  route53_configure || return 1
  CONNECTIVITY_PUBLIC_IP="$("${SCRIPT_DIR}/read-public-address.sh")" || {
    printf 'error: Route 53 host has no public address\n' >&2
    return 1
  }
}

route53_change() {
  local action="$1" change
  change="$(jq -cn --arg action "${action}" --arg name "${CONNECTIVITY_HOST}." --arg ip "${CONNECTIVITY_PUBLIC_IP}" \
    '{Changes:[{Action:$action,ResourceRecordSet:{Name:$name,Type:"A",TTL:30,ResourceRecords:[{Value:$ip}]}}]}')"
  aws route53 change-resource-record-sets --hosted-zone-id "${CONNECTIVITY_ZONE_ID}" \
    --change-batch "${change}" >/dev/null
}

connectivity_publish() { route53_change UPSERT; }

# DELETE includes the exact address this host published. If another session has
# already replaced it, Route 53 refuses the deletion instead of erasing the
# newer address. A stale record then expires only when that replacement stops.
connectivity_retract() {
  route53_configure || return 1
  CONNECTIVITY_PUBLIC_IP="$("${SCRIPT_DIR}/read-public-address.sh")" || return 1
  route53_change DELETE
}
