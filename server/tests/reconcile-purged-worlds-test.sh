#!/usr/bin/env bash

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d /tmp/spawnpoint-purge-reconcile-test.XXXXXXXX)"
trap 'rm -rf -- "${fixture}"' EXIT
mkdir -p -- "${fixture}/bin" "${fixture}/worlds/test-world/generations" "${fixture}/runtime"

current="gen-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
purged_one="gen-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
purged_two="gen-cccccccccccccccccccccccccccccccc"
mkdir -p -- \
  "${fixture}/worlds/test-world/generations/${current}" \
  "${fixture}/worlds/test-world/generations/${purged_one}" \
  "${fixture}/worlds/test-world/generations/${purged_two}"

cat >"${fixture}/catalog.json" <<EOF
{"schema_version":1,"profile_source":{"repository":"https://github.com/example/config","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"worlds":[{"id":"test-world","display_name":"Test world","profile_id":"test","game":"factorio","connectivity":"zerotier","storage_layout":"generation","generation_id":"${current}","release":"1.0","profile_source":{"repository":"https://github.com/example/config","commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]}
EOF
cat >"${fixture}/marker.json" <<EOF
{"schema_version":1,"world_id":"test-world","target_generation_id":"${purged_one}","status":"completed","generation_ids":["${purged_one}","${purged_two}"]}
EOF
cat >"${fixture}/bin/aws" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$1 $2" == "s3api list-objects-v2" ]]; then
  if [[ "${FAKE_NO_MARKERS:-false}" == "true" ]]; then printf 'None\n';
  else printf 'worlds/test-world/purges/gen-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json\n'; fi
elif [[ "$1 $2" == "s3api get-object" ]]; then
  cp -- "${FAKE_PURGE_MARKER}" "${@: -1}"
  printf '{}\n'
else
  printf 'unexpected aws call: %s\n' "$*" >&2
  exit 1
fi
EOF
chmod +x "${fixture}/bin/aws"

output="$(PATH="${fixture}/bin:${PATH}" \
  FAKE_PURGE_MARKER="${fixture}/marker.json" \
  RELEASE_BUCKET="test-releases" \
  SPAWNPOINT_WORLD_CATALOG="${fixture}/catalog.json" \
  SPAWNPOINT_WORLDS_DIRECTORY="${fixture}/worlds" \
  "${repository_root}/server/scripts/reconcile-purged-worlds.sh" test-world)"

grep -qx 'result=reconciled' <<<"${output}"
grep -qx 'removed=2' <<<"${output}"
[[ -d "${fixture}/worlds/test-world/generations/${current}" ]]
[[ ! -e "${fixture}/worlds/test-world/generations/${purged_one}" ]]
[[ ! -e "${fixture}/worlds/test-world/generations/${purged_two}" ]]

empty_output="$(PATH="${fixture}/bin:${PATH}" \
  FAKE_NO_MARKERS=true \
  RELEASE_BUCKET="test-releases" \
  SPAWNPOINT_WORLD_CATALOG="${fixture}/catalog.json" \
  SPAWNPOINT_WORLDS_DIRECTORY="${fixture}/worlds" \
  "${repository_root}/server/scripts/reconcile-purged-worlds.sh" test-world)"
grep -qx 'removed=0' <<<"${empty_output}"

printf 'PASS reconcile-purged-worlds-test.sh\n'
