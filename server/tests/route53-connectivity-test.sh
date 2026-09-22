#!/usr/bin/env bash

set -Eeuo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d /tmp/spawnpoint-route53-test.XXXXXXXX)"
trap 'rm -rf -- "${fixture}"' EXIT
mkdir -p "${fixture}/scripts" "${fixture}/bin"

cp "${root}/server/connectivity/route53.sh" "${fixture}/route53.sh"
printf '#!/usr/bin/env bash\nprintf "203.0.113.10\\n"\n' >"${fixture}/scripts/read-public-address.sh"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >>"${ROUTE53_CALLS}"\n' >"${fixture}/bin/aws"
chmod +x "${fixture}/scripts/read-public-address.sh" "${fixture}/bin/aws"

export PATH="${fixture}/bin:${PATH}"
export ROUTE53_CALLS="${fixture}/calls"
export SPAWNPOINT_DNS_ZONE_ID=Z123ABC
export SPAWNPOINT_DNS_SUFFIX=games.spawnpoint.example.com
export WORLD_ID=factorio-test
# shellcheck disable=SC2034 # Read by the sourced adapter.
SCRIPT_DIR="${fixture}/scripts"
read_env_value() { return 1; }

# shellcheck source=/dev/null
source "${fixture}/route53.sh"
connectivity_prepare
[[ "${CONNECTIVITY_HOST}" == "factorio-test.games.spawnpoint.example.com" ]]
connectivity_publish
connectivity_retract
[[ "$(wc -l <"${ROUTE53_CALLS}")" -eq 2 ]]
grep -Fq 'UPSERT' "${ROUTE53_CALLS}"
grep -Fq 'DELETE' "${ROUTE53_CALLS}"
grep -Fq '203.0.113.10' "${ROUTE53_CALLS}"
grep -Fq 'factorio-test.games.spawnpoint.example.com.' "${ROUTE53_CALLS}"

SPAWNPOINT_DNS_ZONE_ID=bad
if connectivity_prepare >/dev/null 2>&1; then
  printf 'expected refusal for invalid zone ID\n' >&2
  exit 1
fi

printf 'route53-connectivity-test: ok\n'
