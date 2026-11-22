#!/usr/bin/env bash

# RELEASE_STORAGE_LAYOUT (ADR-0080): the flag is off by default and refuses any
# other value; with objects-v1 the script runs the writer (a stub here), then
# plan, then manifest.json last, then publish; packs are reproducible; the
# immutability gate is unchanged; a legacy release stays legacy.

set -Eeuo pipefail

repository_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
scripts="${repository_root}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-upload-objects-test.XXXXXXXX)"
cleanup() {
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

mkdir -p -- "${fixture}/bin"
ln -s -- "${repository_root}/server/tests/fake-aws" "${fixture}/bin/aws"
export PATH="${fixture}/bin:${PATH}"
export RELEASE_BUCKET=spawnpoint-test-releases
export RELEASE_PROFILE_ID=objects
export RELEASE_PROFILE_REPOSITORY=https://github.com/example/config
export RELEASE_PROFILE_COMMIT=0123456789abcdef0123456789abcdef01234567
export FAKE_AWS_CALL_LOG="${fixture}/calls"

# The writer stub logs each call. `write` must run before manifest.json is in
# S3; it adds storage and packs to the manifest, as the real writer does, and
# keeps the packs. `publish` must run after manifest.json is in S3.
cat >"${fixture}/stub-writer" <<'EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
command="$1"
shift
printf '%s %s\n' "${command}" "$*" >>"${STUB_LOG}"
manifest_in_s3="${FAKE_S3_ROOT}/${RELEASE_BUCKET}/releases/minecraft/objects/${STUB_RELEASE}/manifest.json"
case "${command}" in
  write)
    [[ "${STUB_FAIL:-}" != write ]] || exit 1
    heal=false manifest="" packs=()
    while (($#)); do
      case "$1" in
        --manifest) manifest="$2"; shift 2 ;;
        --heal) heal=true; shift ;;
        --pack) packs+=("$2"); shift 2 ;;
        *) shift ;;
      esac
    done
    [[ ! -f "${manifest_in_s3}" || "${heal}" == true ]] || { echo "manifest already in S3 at write" >&2; exit 1; }
    mkdir -p -- "${STUB_KEEP}"
    entries='{}'
    for pack in "${packs[@]}"; do
      name="${pack%%=*}" file="${pack#*=}"
      cp -- "${file}" "${STUB_KEEP}/${name}.zip"
      entries="$(jq -c --arg name "${name}" --arg sha "$(sha256sum "${file}" | cut -d' ' -f1)" --argjson bytes "$(stat --format %s "${file}")" '. + {($name): {sha256: $sha, bytes: $bytes}}' <<<"${entries}")"
    done
    if [[ "${heal}" == false ]]; then
      jq --argjson packs "${entries}" '. + {storage: {layout: "objects-v1"}, packs: $packs}' "${manifest}" >"${manifest}.new"
      mv -- "${manifest}.new" "${manifest}"
    fi
    printf 'layout=objects-v1\nobjects_total=3\nobjects_created=3\nobjects_reused=0\nobjects_recreated=0\nobjects_copied=0\nbytes_uploaded=1\n'
    ;;
  publish)
    [[ -f "${manifest_in_s3}" ]] || { echo "publish before the manifest" >&2; exit 1; }
    ;;
  *) exit 64 ;;
esac
EOF
chmod 0755 "${fixture}/stub-writer"
export RELEASE_WRITER_BIN="${fixture}/stub-writer"
export STUB_LOG="${fixture}/stub.log"

# A release with a players set, so the server and full packs exist too.
make_payload() {
  local dir="$1" release="$2" content="$3"
  mkdir -p -- "${dir}/mods" "${dir}/client-mods"
  printf 'jar one %s\n' "${content}" >"${dir}/mods/alpha.jar"
  printf 'jar two\n' >"${dir}/mods/beta.jar"
  printf 'players only\n' >"${dir}/client-mods/shaders.jar"
  "${scripts}/build-release-manifest.sh" "${release}" 1.20.1 0.19.3 "${dir}/mods" "${dir}/manifest.json" >/dev/null
  jq --arg sha "$(sha256sum "${dir}/client-mods/shaders.jar" | cut -d' ' -f1)" --argjson bytes "$(stat --format %s "${dir}/client-mods/shaders.jar")" \
    '.client = {kind: "mod-set", mods: [{file: "shaders.jar", sha256: $sha, bytes: $bytes}]}' "${dir}/manifest.json" >"${dir}/m.json"
  mv -- "${dir}/m.json" "${dir}/manifest.json"
}

run_upload() {
  local dir="$1"
  shift
  env RELEASE_SOURCE_DIR="${dir}" "$@" "${scripts}/upload-release.sh" "${dir}/manifest.json"
}

new_root() {
  export FAKE_S3_ROOT="${fixture}/s3-$1"
  : >"${FAKE_AWS_CALL_LOG}"
  : >"${STUB_LOG}"
}
release_in_s3() {
  printf '%s/%s/releases/minecraft/objects/%s' "${FAKE_S3_ROOT}" "${RELEASE_BUCKET}" "$1"
}

# --- an invalid value is refused, before anything is written ---
make_payload "${fixture}/a" 1.0 x
new_root invalid
if run_upload "${fixture}/a" RELEASE_STORAGE_LAYOUT=objects-v2 >/dev/null 2>"${fixture}/err"; then fail "an invalid layout was accepted"; fi
grep -q 'RELEASE_STORAGE_LAYOUT must be legacy or objects-v1' "${fixture}/err" || fail "the refusal names no reason"
[[ ! -s "${FAKE_AWS_CALL_LOG}" ]] || fail "an invalid layout reached S3"

# --- unset: legacy keys, no writer ---
new_root legacy
output="$(run_upload "${fixture}/a")"
grep -qx 'result=uploaded' <<<"${output}" || fail "legacy did not upload"
grep -qx 'pack=uploaded' <<<"${output}" || fail "legacy pack line changed"
! grep -q '^layout=' <<<"${output}" || fail "legacy printed a layout"
[[ ! -s "${STUB_LOG}" ]] || fail "legacy called the writer"
[[ -f "$(release_in_s3 1.0)/mods/alpha.jar" && -f "$(release_in_s3 1.0)/client.zip" ]] || fail "legacy keys are missing"
! grep -q 'storage' "$(release_in_s3 1.0)/manifest.json" || fail "legacy manifest has storage"

# --- objects-v1, new release: writer, then manifest last, then publish ---
make_payload "${fixture}/b" 1.1 y
new_root objects
export STUB_RELEASE=1.1 STUB_KEEP="${fixture}/keep1"
output="$(run_upload "${fixture}/b" RELEASE_STORAGE_LAYOUT=objects-v1 RELEASE_BUILD_ID=build-1 RELEASE_PROFILE_DIGEST="$(printf 'a%.0s' {1..64})")"
[[ "$(cut -d' ' -f1 "${STUB_LOG}" | tr '\n' ' ')" == 'write publish ' ]] || fail "writer order: $(cat "${STUB_LOG}")"
grep -q -- '--build-id build-1' "${STUB_LOG}" || fail "build id not passed"
grep -q -- '--profile-digest a' "${STUB_LOG}" || fail "profile digest not passed"
grep -q -- '--pack client=' "${STUB_LOG}" && grep -q -- '--pack server=' "${STUB_LOG}" && grep -q -- '--pack full=' "${STUB_LOG}" || fail "packs not passed"
puts="$(grep put-object "${FAKE_AWS_CALL_LOG}")"
[[ "$(wc -l <<<"${puts}")" == 1 && "${puts}" == *"--key releases/minecraft/objects/1.1/manifest.json "* ]] || fail "only manifest.json may be put by the script: ${puts}"
jq -e '.storage.layout == "objects-v1" and (.packs | has("client") and has("server") and has("full"))' "$(release_in_s3 1.1)/manifest.json" >/dev/null || fail "stored manifest lacks storage and packs"
for line in result=uploaded layout=objects-v1 objects_total=3 pack=objects server_pack=objects full_pack=objects bytes_uploaded=1; do
  grep -qx "${line}" <<<"${output}" || fail "missing result line ${line}"
done
grep -q "^pack_key=objects/sha256/" <<<"${output}" || fail "pack_key is not an object key"

# --- packs are reproducible: other mtimes, same bytes ---
make_payload "${fixture}/c" 1.1 y
touch -d '2001-02-03 04:05:06' "${fixture}"/c/mods/* "${fixture}"/c/client-mods/*
new_root objects2
export STUB_KEEP="${fixture}/keep2"
run_upload "${fixture}/c" RELEASE_STORAGE_LAYOUT=objects-v1 >/dev/null
for name in client server full; do
  [[ "$(sha256sum <"${fixture}/keep1/${name}.zip")" == "$(sha256sum <"${fixture}/keep2/${name}.zip")" ]] || fail "${name} pack is not reproducible"
done
unzip -p "${fixture}/keep1/client.zip" INSTALL.txt | grep -q 'delete your mods folder' -i || fail "install notes changed"

# --- the gate: a different manifest is refused, no writer call ---
new_root gate
export STUB_RELEASE=1.1 STUB_KEEP="${fixture}/keep3"
run_upload "${fixture}/b" RELEASE_STORAGE_LAYOUT=objects-v1 >/dev/null
: >"${STUB_LOG}"
make_payload "${fixture}/d" 1.1 different
if run_upload "${fixture}/d" RELEASE_STORAGE_LAYOUT=objects-v1 >/dev/null 2>"${fixture}/err"; then fail "the gate accepted other content"; fi
grep -q 'already exists with different content' "${fixture}/err" || fail "gate message changed"
[[ ! -s "${STUB_LOG}" ]] || fail "the writer ran after a gate refusal"

# --- an existing objects-v1 release: flag on heals against the stored manifest and keeps it ---
before="$(sha256sum <"$(release_in_s3 1.1)/manifest.json")"
: >"${FAKE_AWS_CALL_LOG}"
output="$(run_upload "${fixture}/b" RELEASE_STORAGE_LAYOUT=objects-v1)"
grep -qx 'result=already_present' <<<"${output}" || fail "heal result"
[[ "$(cut -d' ' -f1 "${STUB_LOG}" | tr '\n' ' ')" == 'write publish write publish ' || "$(cut -d' ' -f1 "${STUB_LOG}" | tr '\n' ' ')" == 'write publish ' ]] || fail "heal calls: $(cat "${STUB_LOG}")"
tail -n 2 "${STUB_LOG}" | head -n 1 | grep -q -- '--heal' || fail "heal flag missing"
[[ "$(sha256sum <"$(release_in_s3 1.1)/manifest.json")" == "${before}" ]] || fail "heal changed the manifest"
! grep -q put-object "${FAKE_AWS_CALL_LOG}" || fail "heal put something through the script"
# flag off: no writer, and no legacy pack inside an objects-v1 release
: >"${STUB_LOG}"
output="$(run_upload "${fixture}/b")"
grep -qx 'result=already_present' <<<"${output}" || fail "flag off result"
[[ ! -s "${STUB_LOG}" && ! -e "$(release_in_s3 1.1)/client.zip" ]] || fail "flag off wrote into an objects-v1 release"

# --- an existing legacy manifest with the flag on behaves as legacy ---
new_root legacy-existing
run_upload "${fixture}/a" >/dev/null
: >"${STUB_LOG}"
rm -- "$(release_in_s3 1.0)/client.zip"
output="$(run_upload "${fixture}/a" RELEASE_STORAGE_LAYOUT=objects-v1)"
grep -qx 'result=already_present' <<<"${output}" || fail "legacy existing result"
grep -qx 'pack=uploaded' <<<"${output}" || fail "legacy existing did not refill the pack"
[[ ! -s "${STUB_LOG}" ]] || fail "writer ran for a legacy release"

# --- a failed writer leaves no manifest ---
new_root failure
if run_upload "${fixture}/b" RELEASE_STORAGE_LAYOUT=objects-v1 STUB_FAIL=write >/dev/null 2>"${fixture}/err"; then fail "a failed writer was ignored"; fi
[[ ! -e "$(release_in_s3 1.1)/manifest.json" ]] || fail "manifest written after a writer failure"

printf 'upload-release-objects-test: ok\n'
