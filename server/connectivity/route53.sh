#!/usr/bin/env bash

route53_configure() {
  local suffix
  CONNECTIVITY_ZONE_ID="${SPAWNPOINT_DNS_ZONE_ID:-$(read_env_value SPAWNPOINT_DNS_ZONE_ID)}"
  suffix="${SPAWNPOINT_DNS_SUFFIX:-$(read_env_value SPAWNPOINT_DNS_SUFFIX)}"
  [[ "${CONNECTIVITY_ZONE_ID}" =~ ^Z[A-Z0-9]+$ ]] || { printf 'error: invalid Route 53 zone ID\n' >&2; return 1; }
  [[ "${suffix}" =~ ^[a-z0-9-]+(\.[a-z0-9-]+)+$ ]] || { printf 'error: invalid DNS suffix\n' >&2; return 1; }
  [[ "${WORLD_ID:-}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || { printf 'error: Route 53 requires a world ID\n' >&2; return 1; }
  CONNECTIVITY_HOST="${WORLD_ID}.${suffix}"
  CONNECTIVITY_LEDGER_TABLE="${SPAWNPOINT_DNS_LEDGER_TABLE:-$(read_env_value SPAWNPOINT_DNS_LEDGER_TABLE)}"
  CONNECTIVITY_INSTANCE_ID="${SPAWNPOINT_INSTANCE_ID:-$(read_env_value SPAWNPOINT_INSTANCE_ID)}"
  [[ "${CONNECTIVITY_LEDGER_TABLE}" =~ ^[A-Za-z0-9_.-]{3,255}$ ]] || { printf 'error: invalid DNS ledger table\n' >&2; return 1; }
  [[ "${CONNECTIVITY_INSTANCE_ID}" =~ ^i-[0-9a-f]+$ ]] || { printf 'error: invalid instance ID for DNS ledger\n' >&2; return 1; }
  return 0
}

route53_ledger_key() {
  jq -cn --arg host "dns-host#${CONNECTIVITY_INSTANCE_ID}" '{server_id:{S:$host}}'
}

route53_ledger_record() {
  jq -cn --arg zone "${CONNECTIVITY_ZONE_ID}" --arg name "${CONNECTIVITY_HOST}." --arg ip "${CONNECTIVITY_PUBLIC_IP}" \
    '{":record":{M:{zone_id:{S:$zone},name:{S:$name},address:{S:$ip}}}}'
}

route53_ledger_publish() {
  local error item names values
  item="$(jq -cn --arg host "dns-host#${CONNECTIVITY_INSTANCE_ID}" '{server_id:{S:$host},records:{M:{}}}')"
  if ! error="$(aws dynamodb put-item --table-name "${CONNECTIVITY_LEDGER_TABLE}" \
    --item "${item}" --condition-expression 'attribute_not_exists(server_id)' 2>&1)"; then
    [[ "${error}" == *ConditionalCheckFailedException* ]] || { printf '%s\n' "${error}" >&2; return 1; }
  fi
  names="$(jq -cn --arg world "${WORLD_ID}" '{"#records":"records","#world":$world}')"
  values="$(route53_ledger_record)"
  aws dynamodb update-item --table-name "${CONNECTIVITY_LEDGER_TABLE}" \
    --key "$(route53_ledger_key)" --update-expression 'SET #records.#world = :record' \
    --condition-expression 'attribute_exists(server_id)' \
    --expression-attribute-names "${names}" --expression-attribute-values "${values}" >/dev/null || return 1
  return 0
}

route53_ledger_retract() {
  local names values error
  names="$(jq -cn --arg world "${WORLD_ID}" '{"#records":"records","#world":$world,"#address":"address"}')"
  values="$(jq -cn --arg ip "${CONNECTIVITY_PUBLIC_IP}" '{":address":{S:$ip}}')"
  if ! error="$(aws dynamodb update-item --table-name "${CONNECTIVITY_LEDGER_TABLE}" \
    --key "$(route53_ledger_key)" --update-expression 'REMOVE #records.#world' \
    --condition-expression '#records.#world.#address = :address' \
    --expression-attribute-names "${names}" --expression-attribute-values "${values}" 2>&1)"; then
    [[ "${error}" == *ConditionalCheckFailedException* ]] || { printf '%s\n' "${error}" >&2; return 1; }
  fi
  return 0
}

connectivity_prepare() {
  route53_configure || return 1
  CONNECTIVITY_PUBLIC_IP="$("${SCRIPT_DIR}/read-public-address.sh")" || {
    printf 'error: Route 53 host has no public address\n' >&2
    return 1
  }
  return 0
}

route53_change() {
  local action="$1" change
  change="$(jq -cn --arg action "${action}" --arg name "${CONNECTIVITY_HOST}." --arg ip "${CONNECTIVITY_PUBLIC_IP}" \
    '{Changes:[{Action:$action,ResourceRecordSet:{Name:$name,Type:"A",TTL:30,ResourceRecords:[{Value:$ip}]}}]}')"
  aws route53 change-resource-record-sets --hosted-zone-id "${CONNECTIVITY_ZONE_ID}" \
    --change-batch "${change}" >/dev/null || return 1
  return 0
}

connectivity_publish() {
  route53_ledger_publish || return 1
  if ! route53_change UPSERT; then
    route53_ledger_retract || true
    return 1
  fi
  return 0
}

# DELETE includes the exact address this host published. If another session has
# already replaced it, Route 53 refuses the deletion instead of erasing the
# newer address. The terminal-host EventBridge reconciler handles crashes.
connectivity_retract() {
  route53_configure || return 1
  CONNECTIVITY_PUBLIC_IP="$("${SCRIPT_DIR}/read-public-address.sh")" || return 1
  route53_change DELETE || return 1
  route53_ledger_retract || return 1
  return 0
}
