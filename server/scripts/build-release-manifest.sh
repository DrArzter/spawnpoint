#!/usr/bin/env bash

set -Eeuo pipefail

# shellcheck source=../games/_legacy-game.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/../games/_legacy-game.sh"

usage() {
  cat >&2 <<'EOF'
usage: build-release-manifest.sh <release> <minecraft-version> <loader-version> <mods-directory> <output-manifest>

Environment:
  RELEASE_CREATED_BY  Identity recorded in the release (default: local-operator)
  RELEASE_CHANGELOG   Short release description (default: Baseline release)
  RELEASE_PROFILE_ID, RELEASE_PROFILE_REPOSITORY, RELEASE_PROFILE_COMMIT
                      Optional all-or-nothing provenance for a source profile
  RELEASE_RUNTIME_IMAGE
                      Optional immutable container reference selected by the profile
  RELEASE_LOADER_TYPE Optional Minecraft loader type (default: forge)
  RELEASE_SERVER_OVERRIDES_DIR
                      Optional normalized server configuration tree
  RELEASE_CLIENT_PACK Optional complete launcher-importable client archive
  RELEASE_CLIENT_MODS_DIR
                      Optional players' mod set, when it differs from the server's (ADR-0069);
                      not together with RELEASE_CLIENT_PACK
  RELEASE_CLIENT_ADDONS
                      Optional addons lock (ADR-0077), with RELEASE_CLIENT_PACK only: recorded as client.addons
  RELEASE_CLIENT_ADDONS_DIR
                      The client-only addon files of that lock
  RELEASE_MOD_INDEX   Optional descriptive map of SHA-256 to mod ids, recorded as the top-level mod_index
  RELEASE_MOD_SOURCE  Optional curseforge, modrinth or github: where the resolver fetched the release's mods.
                      An addon records the source its lock pins. Descriptive only, outside the identity gate.
EOF
}

[[ $# -eq 5 ]] || {
  usage
  exit 2
}

release="$1"
minecraft_version="$2"
loader_version="$3"
mods_dir="$(realpath -e -- "$4")"
output_manifest="$(realpath -m -- "$5")"
created_by="${RELEASE_CREATED_BY:-local-operator}"
changelog="${RELEASE_CHANGELOG:-Baseline release}"
# The game decides the mod file extension and loader.type; the version
# argument carries that game's version. Absent means the legacy game
# (ADR-0089), so every existing caller keeps its exact pre-axis behaviour.
release_game="${RELEASE_GAME:-${LEGACY_GAME_ID}}"
case "${release_game}" in
  minecraft)
    mod_extension="jar"
    loader_type="${RELEASE_LOADER_TYPE:-forge}"
    case "${loader_type}" in
      vanilla | forge | neoforge | fabric | quilt) ;;
      *)
        printf 'error: unsupported Minecraft loader type: %s\n' "${loader_type}" >&2
        exit 1
        ;;
    esac
    ;;
  factorio)
    mod_extension="zip"
    loader_type="factorio"
    ;;
  zomboid)
    mod_extension="zip"
    loader_type="workshop"
    ;;
  *)
    printf 'error: unknown RELEASE_GAME: %s\n' "${release_game}" >&2
    exit 1
    ;;
esac
profile_id="${RELEASE_PROFILE_ID:-}"
profile_repository="${RELEASE_PROFILE_REPOSITORY:-}"
profile_commit="${RELEASE_PROFILE_COMMIT:-}"
runtime_image="${RELEASE_RUNTIME_IMAGE:-}"
overrides_dir="${RELEASE_SERVER_OVERRIDES_DIR:-}"
client_pack="${RELEASE_CLIENT_PACK:-}"
client_mods_dir="${RELEASE_CLIENT_MODS_DIR:-}"
client_addons="${RELEASE_CLIENT_ADDONS:-}"
client_addons_dir="${RELEASE_CLIENT_ADDONS_DIR:-}"
mod_index="${RELEASE_MOD_INDEX:-}"
mod_source="${RELEASE_MOD_SOURCE:-}"

command -v jq >/dev/null 2>&1 || {
  printf 'error: required command not found: jq\n' >&2
  exit 1
}
command -v sha256sum >/dev/null 2>&1 || {
  printf 'error: required command not found: sha256sum\n' >&2
  exit 1
}
[[ -d "${mods_dir}" ]] || {
  printf 'error: mods directory does not exist: %s\n' "${mods_dir}" >&2
  exit 1
}
[[ "${release}" =~ ^[0-9]+\.[0-9]+$ ]] || {
  printf 'error: release must use MAJOR.MINOR: %s\n' "${release}" >&2
  exit 1
}
profile_fields=0
[[ -n "${profile_id}" ]] && profile_fields=$((profile_fields + 1))
[[ -n "${profile_repository}" ]] && profile_fields=$((profile_fields + 1))
[[ -n "${profile_commit}" ]] && profile_fields=$((profile_fields + 1))
[[ "${profile_fields}" == 0 || "${profile_fields}" == 3 ]] || {
  printf 'error: profile provenance must provide id, repository and commit together\n' >&2
  exit 1
}
if (( profile_fields == 3 )); then
  [[ "${profile_id}" =~ ^[a-z0-9][a-z0-9-]{0,31}$ ]] || {
    printf 'error: invalid source profile id: %s\n' "${profile_id}" >&2
    exit 1
  }
  [[ "${profile_commit}" =~ ^[0-9a-f]{40}$ ]] || {
    printf 'error: source profile commit must be a full lowercase Git SHA\n' >&2
    exit 1
  }
fi
if [[ -n "${runtime_image}" && ! "${runtime_image}" =~ ^[A-Za-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]]; then
  printf 'error: runtime image must be a digest-addressed container reference\n' >&2
  exit 1
fi
if [[ "${release_game}" == "factorio" && -z "${runtime_image}" ]]; then
  printf 'error: factorio releases require RELEASE_RUNTIME_IMAGE\n' >&2
  exit 1
fi
if [[ -n "${overrides_dir}" ]]; then
  overrides_dir="$(realpath -e -- "${overrides_dir}")"
  [[ -d "${overrides_dir}" && ! -L "${overrides_dir}" ]] || {
    printf 'error: server overrides must be a regular directory\n' >&2
    exit 1
  }
fi
if [[ -n "${client_pack}" ]]; then
  client_pack="$(realpath -e -- "${client_pack}")"
  [[ -f "${client_pack}" && ! -L "${client_pack}" && "${client_pack}" == *.zip ]] || {
    printf 'error: client pack must be a regular zip file\n' >&2
    exit 1
  }
fi
if [[ -n "${client_mods_dir}" ]]; then
  [[ -z "${client_pack}" ]] || {
    printf 'error: a release has a client pack or a players mod set, not both\n' >&2
    exit 1
  }
  client_mods_dir="$(realpath -e -- "${client_mods_dir}")"
  [[ -d "${client_mods_dir}" && ! -L "${client_mods_dir}" ]] || {
    printf 'error: client mods must be a regular directory\n' >&2
    exit 1
  }
fi
if [[ -n "${client_addons}" ]]; then
  [[ -n "${client_pack}" ]] || {
    printf 'error: addons extend a client pack; RELEASE_CLIENT_PACK is required\n' >&2
    exit 1
  }
  client_addons="$(realpath -e -- "${client_addons}")"
  [[ -z "${client_addons_dir}" ]] || client_addons_dir="$(realpath -e -- "${client_addons_dir}")"
fi
case "${mod_source}" in
  "" | curseforge | modrinth | github) ;;
  *)
    printf 'error: unsupported mod source: %s\n' "${mod_source}" >&2
    exit 1
    ;;
esac
if [[ -n "${mod_index}" ]]; then
  mod_index="$(realpath -e -- "${mod_index}")"
  jq -e 'type == "object" and all(to_entries[];
    (.key | test("^[0-9a-f]{64}$")) and (.value | type == "array" and all(.[]; type == "string")))' \
    "${mod_index}" >/dev/null || {
    printf 'error: mod index must map SHA-256 digests to mod ids\n' >&2
    exit 1
  }
fi
[[ ! -e "${output_manifest}" && ! -L "${output_manifest}" ]] || {
  printf 'error: immutable release manifest already exists: %s\n' "${output_manifest}" >&2
  exit 1
}

mkdir -p -- "$(dirname -- "${output_manifest}")"
entries_file="$(mktemp)"
client_entries_file="$(mktemp)"
addon_entries_file="$(mktemp)"
overrides_file="$(mktemp)"
output_tmp="$(mktemp "$(dirname -- "${output_manifest}")/.manifest.XXXXXX")"
cleanup() {
  rm -f -- "${entries_file}" "${client_entries_file}" "${addon_entries_file}" "${overrides_file}" "${output_tmp}"
}
trap cleanup EXIT

# One {file, sha256, bytes} line per mod file in a directory, in name order;
# prints how many.
mod_entries() {
  local directory="$1" entries="$2" mod filename sha256 bytes count=0
  while IFS= read -r -d '' mod; do
    filename="$(basename -- "${mod}")"
    [[ "${filename}" != *$'\n'* && "${filename}" != *$'\t'* ]] || {
      printf 'error: mod filename contains a tab or newline: %q\n' "${filename}" >&2
      exit 1
    }

    sha256="$(sha256sum -- "${mod}")"
    sha256="${sha256%% *}"
    bytes="$(stat --format '%s' -- "${mod}")"
    jq -cn \
      --arg file "${filename}" \
      --arg sha256 "${sha256}" \
      --argjson bytes "${bytes}" \
      '{file: $file, sha256: $sha256, bytes: $bytes}' >>"${entries}"
    count=$((count + 1))
  done < <(find "${directory}" -maxdepth 1 -type f -name "*.${mod_extension}" -print0 | sort -z)
  printf '%s' "${count}"
}

count="$(mod_entries "${mods_dir}" "${entries_file}")"
client_count=0
if [[ -n "${client_mods_dir}" ]]; then
  client_count="$(mod_entries "${client_mods_dir}" "${client_entries_file}")"
  (( client_count > 0 )) || {
    printf 'error: a players mod set must hold at least one mod\n' >&2
    exit 1
  }
  # A name both sets carry is one file, fetched from the server's mods: the
  # same name with other bytes would be two mods a player could not tell apart.
  jq -se --slurpfile server "${entries_file}" '
    ($server | map({key: .file, value: .sha256}) | from_entries) as $by_file |
    all(.[]; ($by_file[.file] // .sha256) == .sha256)
  ' "${client_entries_file}" >/dev/null || {
    printf 'error: a players mod shares a name with a server mod but not its bytes\n' >&2
    exit 1
  }
fi

# Each addon as the release holds it: both and server addons are server mods,
# client addons are files of their own. The digest is checked against the lock.
addon_count=0
if [[ -n "${client_addons}" ]]; then
  while IFS=$'\t' read -r filename side locked_sha256 addon_source; do
    addon_file="${mods_dir}/${filename}"
    if [[ "${side}" == client ]]; then
      addon_file=""
      [[ -z "${client_addons_dir}" ]] || addon_file="${client_addons_dir}/${filename}"
    fi
    [[ -n "${addon_file}" && -f "${addon_file}" && ! -L "${addon_file}" ]] || {
      printf 'error: addon %s (%s) is missing from the release payload\n' "${filename}" "${side}" >&2
      exit 1
    }
    sha256="$(sha256sum -- "${addon_file}")"
    sha256="${sha256%% *}"
    [[ "${sha256}" == "${locked_sha256}" ]] || {
      printf 'error: addon %s does not match its lock\n' "${filename}" >&2
      exit 1
    }
    jq -cn --arg file "${filename}" --arg sha256 "${sha256}" --arg side "${side}" --arg source "${addon_source}" \
      --argjson bytes "$(stat --format '%s' -- "${addon_file}")" \
      '{file: $file, sha256: $sha256, bytes: $bytes, side: $side} + if $source == "none" then {} else {source: $source} end' \
      >>"${addon_entries_file}"
    addon_count=$((addon_count + 1))
  # "none" stands for a lock written before sources: a tab-separated empty field would collapse.
  done < <(jq -r '.mods[] | [.file, .side, .sha256, (.source | keys[0] // "none" | if . == "github_release" then "github" else . end)] | @tsv' "${client_addons}")
  (( addon_count > 0 )) || {
    printf 'error: an addons lock must hold at least one addon\n' >&2
    exit 1
  }
fi

override_count=0
if [[ -n "${overrides_dir}" ]]; then
  if find "${overrides_dir}" -mindepth 1 \( -type l -o ! -type f -a ! -type d \) -print -quit | grep -q .; then
    printf 'error: server overrides contain a symbolic link or special file\n' >&2
    exit 1
  fi
  while IFS= read -r -d '' override; do
    relative="${override#"${overrides_dir}/"}"
    [[ -n "${relative}" && "${relative}" != /* && "${relative}" != *\\* && "${relative}" != *$'\n'* && "${relative}" != *$'\t'* ]] || {
      printf 'error: unsafe server override path: %q\n' "${relative}" >&2
      exit 1
    }
    IFS='/' read -r -a components <<<"${relative}"
    for component in "${components[@]}"; do
      [[ -n "${component}" && "${component}" != "." && "${component}" != ".." ]] || {
        printf 'error: unsafe server override path: %q\n' "${relative}" >&2
        exit 1
      }
    done
    case "${components[0]}" in
      config | defaultconfigs | kubejs | scripts | global_packs | openloader) ;;
      *)
        printf 'error: unmanaged server override root: %s\n' "${components[0]}" >&2
        exit 1
        ;;
    esac
    sha256="$(sha256sum -- "${override}")"
    sha256="${sha256%% *}"
    bytes="$(stat --format '%s' -- "${override}")"
    jq -cn \
      --arg path "${relative}" \
      --arg sha256 "${sha256}" \
      --argjson bytes "${bytes}" \
      '{path: $path, sha256: $sha256, bytes: $bytes}' >>"${overrides_file}"
    override_count=$((override_count + 1))
  done < <(find "${overrides_dir}" -type f -print0 | sort -z)
fi

# Paths the addons keep as world data inside the managed roots (ADR-0077): the
# overrides swap leaves them in place, and backups carry them. A path that
# overlaps a file this release ships would have two owners.
world_data='[]'
if [[ -n "${client_addons}" ]]; then
  world_data="$(jq -c '[.mods[].world_data // [] | .[]] | sort' "${client_addons}")"
fi
jq -e -n --argjson paths "${world_data}" --slurpfile overrides "${overrides_file}" '
  def overlaps($a; $b): $a == $b or ($a | startswith($b + "/")) or ($b | startswith($a + "/"));
  all($paths[]; type == "string" and (test("[\\t\\n\\\\]") | not) and
    test("^(config|defaultconfigs|kubejs|scripts|global_packs|openloader)(/[^/]+)+$") and
    (split("/") | all(. != "." and . != ".."))) and
  all(range($paths | length) as $i | range($i + 1; $paths | length) as $j | [$i, $j];
    overlaps($paths[.[0]]; $paths[.[1]]) | not)
' >/dev/null || {
  printf 'error: invalid or overlapping world_data paths in the addons lock\n' >&2
  exit 1
}
world_data_conflict="$(jq -r -n --argjson paths "${world_data}" --slurpfile overrides "${overrides_file}" '
  def overlaps($a; $b): $a == $b or ($a | startswith($b + "/")) or ($b | startswith($a + "/"));
  first($paths[] as $path | $overrides[] | select(overlaps(.path; $path)) | "\($path) and \(.path)") // empty
')"
[[ -z "${world_data_conflict}" ]] || {
  printf 'error: a world_data path overlaps a file the release ships: %s\n' "${world_data_conflict}" >&2
  exit 1
}

client_sha256=""
client_bytes=0
if [[ -n "${client_pack}" ]]; then
  client_sha256="$(sha256sum -- "${client_pack}")"
  client_sha256="${client_sha256%% *}"
  client_bytes="$(stat --format '%s' -- "${client_pack}")"
fi

jq -s \
  --slurpfile overrides "${overrides_file}" \
  --slurpfile client_mods "${client_entries_file}" \
  --slurpfile client_addons "${addon_entries_file}" \
  --slurpfile mod_index "${mod_index:-/dev/null}" \
  --arg release "${release}" \
  --arg minecraft_version "${minecraft_version}" \
  --arg loader_version "${loader_version}" \
  --arg created_at "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" \
  --arg created_by "${created_by}" \
  --arg changelog "${changelog}" \
  --arg game "${release_game}" \
  --arg loader_type "${loader_type}" \
  --arg profile_id "${profile_id}" \
  --arg profile_repository "${profile_repository}" \
  --arg profile_commit "${profile_commit}" \
  --arg runtime_image "${runtime_image}" \
  --arg client_sha256 "${client_sha256}" \
  --arg mod_source "${mod_source}" \
  --argjson client_bytes "${client_bytes}" \
  --argjson world_data "${world_data}" \
  '# A pinned addon keeps the source its lock names; every other mod has the resolver source.
  ($client_addons | map(select(.source != null) | {key: .sha256, value: .source}) | from_entries) as $addon_sources |
  def sourced: . + ((($addon_sources[.sha256] // (if $mod_source == "" then null else $mod_source end)) as $source |
    if $source == null then {} else {source: $source} end));
  ({
    schema_version: 1,
    game: $game,
    release: $release,
    minecraft_version: $minecraft_version,
    loader: {type: $loader_type, version: $loader_version},
    created_at: $created_at,
    created_by: $created_by,
    changelog: $changelog,
    server: ({mods: map(sourced)} + if ($overrides | length) == 0 then {} else {overrides: $overrides} end
      + if ($world_data | length) == 0 then {} else {world_data: $world_data} end)
  } + if $runtime_image == "" then {} else {
    runtime: {image: $runtime_image}
  } end + if $client_sha256 == "" then {} else {
    client: ({file: "client.zip", sha256: $client_sha256, bytes: $client_bytes, kind: "curseforge-modpack"} +
      if ($client_addons | length) == 0 then {} else {addons: ($client_addons | sort_by(.file))} end)
  } end + if ($client_mods | length) == 0 then {} else {
    client: {kind: "mod-set", mods: ($client_mods | map(sourced))}
  } end + if $profile_id == "" then {} else {
    source_profile: {
      id: $profile_id,
      repository: $profile_repository,
      commit: $profile_commit
    }
  } end + if ($mod_index | length) == 0 then {} else {
    mod_index: $mod_index[0]
  } end)' "${entries_file}" >"${output_tmp}"

chmod 0644 "${output_tmp}"
mv -- "${output_tmp}" "${output_manifest}"
printf 'result=manifest_created\n'
printf 'release=%s\n' "${release}"
printf 'manifest=%s\n' "${output_manifest}"
printf 'mods=%d\n' "${count}"
printf 'client_mods=%d\n' "${client_count}"
printf 'overrides=%d\n' "${override_count}"
printf 'addons=%d\n' "${addon_count}"
printf 'world_data=%d\n' "$(jq -r 'length' <<<"${world_data}")"
