#!/usr/bin/env bash

# Adds a release's addons to the modpack client pack (ADR-0077), so players
# still import one archive. The both and client JARs go under the pack's
# overrides mods/, the addon config under its overrides, and every addon pin
# into spawnpoint-client-lock.json. The manifest keeps files: [] and its
# version becomes <upstream>+<release>, so players can tell the packs apart.

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

upstream_pack="${1:-}"
client_payload="${2:-}"
lock="${3:-}"
release="${4:-}"
output_pack="${5:-}"
[[ -n "${upstream_pack}" && -n "${client_payload}" && -n "${lock}" && -n "${release}" && -n "${output_pack}" ]] ||
  die "usage: extend-client-pack.sh <upstream-client.zip> <client-payload-directory> <addons-lock.json> <release> <new-client.zip>"
for command in find jq realpath touch unzip zip; do
  require_command "${command}"
done
[[ "${release}" =~ ^[0-9]+\.[0-9]+$ ]] || die "release must use MAJOR.MINOR: ${release}"
upstream_pack="$(realpath -e -- "${upstream_pack}")"
client_payload="$(realpath -e -- "${client_payload}")"
lock="$(realpath -e -- "${lock}")"
output_pack="$(realpath -m -- "${output_pack}")"
[[ ! -e "${output_pack}" && ! -L "${output_pack}" ]] || die "immutable client pack already exists: ${output_pack}"

workspace="$(mktemp -d)"
cleanup() {
  rm -rf -- "${workspace}"
}
trap cleanup EXIT
tree="${workspace}/tree"
mkdir -p -- "${tree}"
# The upstream pack is this build's own resolver output; its paths were checked there.
unzip -q "${upstream_pack}" -d "${tree}"
overrides="$(jq -er '.overrides | select(test("^[A-Za-z0-9_-]+$"))' "${tree}/manifest.json")" ||
  die "client pack manifest has no safe overrides directory"
jq -e '.version | type == "string" and length > 0' "${tree}/manifest.json" >/dev/null ||
  die "client pack manifest has no version"

mkdir -p -- "${tree}/${overrides}/mods"
if [[ -d "${client_payload}/mods" ]]; then
  while IFS= read -r -d '' jar; do
    target="${tree}/${overrides}/mods/$(basename -- "${jar}")"
    [[ ! -e "${target}" ]] || die "the client pack already has $(basename -- "${jar}")"
    cp -- "${jar}" "${target}"
  done < <(find "${client_payload}/mods" -maxdepth 1 -type f -name '*.jar' -print0)
fi
# Config replacements were checked against config.replaces before this step.
if [[ -d "${client_payload}/overrides" ]]; then
  cp -R -- "${client_payload}/overrides/." "${tree}/${overrides}/"
fi

jq --arg release "${release}" '.files = [] | .version = "\(.version)+\($release)"' \
  "${tree}/manifest.json" >"${workspace}/manifest.json"
mv -- "${workspace}/manifest.json" "${tree}/manifest.json"
jq --slurpfile lock "${lock}" --arg overrides "${overrides}" '
  .addons = [$lock[0].mods[] | select(.side != "server") |
    {name, side, source, path: ("mods/" + .file), sha256, bytes}]
' "${tree}/spawnpoint-client-lock.json" >"${workspace}/lock.json"
mv -- "${workspace}/lock.json" "${tree}/spawnpoint-client-lock.json"

# The same deterministic archive rules as the modpack resolver.
find "${tree}" -type f -exec touch -t 200001010000 {} +
(cd "${tree}" && find . -type f | LC_ALL=C sort | zip -X -q "${workspace}/client.zip" -@)
mv -- "${workspace}/client.zip" "${output_pack}"

printf 'result=extended\n'
printf 'version=%s\n' "$(jq -r '.version' "${tree}/manifest.json")"
printf 'output=%s\n' "${output_pack}"
