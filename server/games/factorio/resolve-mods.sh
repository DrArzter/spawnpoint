#!/usr/bin/env bash

# Resolve a pinned Factorio mod list (<name>:<version> per line) from the mod
# portal into a payload directory. Distribution model B: the portal keeps
# versions, so pins are real, and connecting clients sync the same list from
# the portal themselves — no client pack exists for this game.
#
# The portal's browse API is public; only the download needs credentials
# (FACTORIO_USERNAME and FACTORIO_TOKEN, from factorio.com/profile). The
# server itself never needs an account: credentials are a cut-time concern.
# An empty list resolves to an empty payload without contacting the portal.
#
# Two things the portal knows and a flat pin list does not, both fatal at the
# server rather than here if unchecked: which engine series a mod release
# declares, and which other mods it requires. The /full endpoint carries both
# (info_json.factorio_version and info_json.dependencies; the short endpoint
# omits dependencies), so resolution validates the list as a set, not as
# independent lines.

set -Eeuo pipefail

list="${1:-}"
output_dir="${2:-}"
[[ -n "${list}" && -n "${output_dir}" ]] || {
  printf 'usage: resolve-mods.sh <mods.list> <output-directory>\n' >&2
  exit 2
}

for command in curl jq sha1sum; do
  command -v "${command}" >/dev/null 2>&1 || {
    printf 'error: required command not found: %s\n' "${command}" >&2
    exit 1
  }
done

api_base="${FACTORIO_API_BASE:-https://mods.factorio.com}"
# The engine series this pack is for ("2.0"), from the profile when resolution
# runs through one. Absent means the engine check cannot run, and the output
# says so rather than staying quiet about it.
target_engine="${FACTORIO_TARGET_VERSION:-}"
engine_series=""
if [[ -n "${target_engine}" ]]; then
  [[ "${target_engine}" =~ ^([0-9]+\.[0-9]+) ]] || {
    printf 'error: FACTORIO_TARGET_VERSION must look like 2.0 or 2.0.77: %s\n' "${target_engine}" >&2
    exit 1
  }
  engine_series="${BASH_REMATCH[1]}"
fi

# Portal dependency syntax: an optional prefix (! incompatible, ? and (?)
# optional, ~ required without load order), a mod name, then an optional
# version constraint. Only required entries must be present in the list;
# optional ones are the author's suggestion, not our problem.
version_satisfies() {
  local have="$1" operator="$2" want="$3" lower
  lower="$(printf '%s\n%s\n' "${have}" "${want}" | sort -V | head -n1)"
  case "${operator}" in
    '=') [[ "${have}" == "${want}" ]] ;;
    '>=') [[ "${have}" == "${want}" || "${lower}" == "${want}" ]] ;;
    '>') [[ "${have}" != "${want}" && "${lower}" == "${want}" ]] ;;
    '<=') [[ "${have}" == "${want}" || "${lower}" == "${have}" ]] ;;
    '<') [[ "${have}" != "${want}" && "${lower}" == "${have}" ]] ;;
    *) return 1 ;;
  esac
}
list="$(realpath -e -- "${list}")"
output_dir="$(realpath -m -- "${output_dir}")"
mkdir -p -- "${output_dir}/mods"

entries=()
while IFS= read -r line; do
  entry="${line%%#*}"
  entry="${entry//[[:space:]]/}"
  [[ -n "${entry}" ]] || continue
  [[ "${entry}" =~ ^([A-Za-z0-9_-]+):([0-9]+(\.[0-9]+)*)$ ]] || {
    printf 'error: unparseable mod list entry: %s\n' "${line}" >&2
    exit 1
  }
  entries+=("${entry}")
done <"${list}"

if (( ${#entries[@]} == 0 )); then
  printf 'result=resolved\n'
  printf 'payload=%s\n' "${output_dir}"
  printf 'resolved=0\n'
  printf 'downloaded=0\n'
  printf 'kept=0\n'
  printf 'engine_check=%s\n' "${engine_series:-skipped}"
  printf 'required_dependencies=0\n'
  exit 0
fi

[[ -n "${FACTORIO_USERNAME:-}" && -n "${FACTORIO_TOKEN:-}" ]] || {
  printf 'error: FACTORIO_USERNAME and FACTORIO_TOKEN are required to download mods (factorio.com/profile); the server itself never needs them\n' >&2
  exit 1
}

resolved=0
downloaded=0
kept=0
declare -a required_deps=()
declare -a incompatible_with=()
for entry in "${entries[@]}"; do
  name="${entry%%:*}"
  version="${entry##*:}"

  mod_json="$(curl -fsSL "${api_base}/api/mods/${name}/full")" || {
    printf 'error: mod portal lookup failed for %s\n' "${name}" >&2
    exit 1
  }
  release="$(jq -ce --arg version "${version}" '[.releases[] | select(.version == $version)][0]' <<<"${mod_json}")" || {
    printf 'error: %s has no release %s on the portal\n' "${name}" "${version}" >&2
    exit 1
  }
  file_name="$(jq -r '.file_name // empty' <<<"${release}")"
  sha1_expected="$(jq -r '.sha1 // empty' <<<"${release}")"
  download_url="$(jq -r '.download_url // empty' <<<"${release}")"
  [[ "${file_name}" =~ ^[A-Za-z0-9][A-Za-z0-9._+-]*\.zip$ ]] || {
    printf 'error: unsafe or non-zip file name from the portal for %s: %s\n' "${entry}" "${file_name}" >&2
    exit 1
  }
  [[ "${sha1_expected}" =~ ^[0-9a-f]{40}$ ]] || {
    printf 'error: no SHA-1 from the portal for %s\n' "${entry}" >&2
    exit 1
  }
  [[ -n "${download_url}" ]] || {
    printf 'error: no download url from the portal for %s\n' "${entry}" >&2
    exit 1
  }

  # Factorio loads a mod only if the series it declares is the game's own, so a
  # 1.1 mod on a 2.0 server is a refused start, not a warning.
  release_engine="$(jq -r '.info_json.factorio_version // empty' <<<"${release}")"
  if [[ -n "${engine_series}" ]]; then
    [[ "${release_engine}" == "${engine_series}" ]] || {
      printf 'error: %s %s declares factorio %s, and this pack targets %s\n' \
        "${name}" "${version}" "${release_engine:-none}" "${engine_series}" >&2
      exit 1
    }
  fi

  while IFS= read -r dependency; do
    [[ -n "${dependency}" ]] || continue
    case "${dependency}" in
      '!'*) incompatible_with+=("${name}|$(sed -E 's/^![[:space:]]*//; s/[[:space:]].*$//' <<<"${dependency}")") ;;
      '?'* | '(?)'*) ;;
      *)
        # Required, with or without the load-order-only ~ prefix.
        required_deps+=("${name}|$(sed -E 's/^~?[[:space:]]*//' <<<"${dependency}")")
        ;;
    esac
  done < <(jq -r '.info_json.dependencies // [] | .[]' <<<"${release}")

  resolved=$((resolved + 1))
  target="${output_dir}/mods/${file_name}"
  if [[ -f "${target}" && ! -L "${target}" ]]; then
    actual="$(sha1sum -- "${target}")"
    if [[ "${actual%% *}" == "${sha1_expected}" ]]; then
      kept=$((kept + 1))
      continue
    fi
    printf 'cached %s does not match the pinned release; refetching\n' "${file_name}" >&2
    rm -f -- "${target}"
  fi

  fetch_tmp="$(mktemp "${output_dir}/mods/.${file_name}.XXXXXX")"
  curl -fsSL -o "${fetch_tmp}" \
    "${api_base}${download_url}?username=${FACTORIO_USERNAME}&token=${FACTORIO_TOKEN}" || {
    rm -f -- "${fetch_tmp}"
    printf 'error: download failed for %s\n' "${entry}" >&2
    exit 1
  }
  actual="$(sha1sum -- "${fetch_tmp}")"
  [[ "${actual%% *}" == "${sha1_expected}" ]] || {
    rm -f -- "${fetch_tmp}"
    printf 'error: downloaded %s does not match the pinned SHA-1\n' "${file_name}" >&2
    exit 1
  }
  mv -- "${fetch_tmp}" "${target}"
  downloaded=$((downloaded + 1))
done

# The list is only a pack if it stands on its own: every required dependency
# pinned, and nothing pinned that another mod refuses to load beside.
declare -A pinned_versions=()
for entry in "${entries[@]}"; do
  pinned_versions["${entry%%:*}"]="${entry##*:}"
done

for record in "${required_deps[@]}"; do
  requester="${record%%|*}"
  requirement="${record#*|}"
  read -r dep_name operator wanted <<<"${requirement}"
  [[ "${dep_name}" != "base" ]] || continue
  have="${pinned_versions[${dep_name}]:-}"
  [[ -n "${have}" ]] || {
    printf 'error: %s requires %s, which the pin list does not contain\n' "${requester}" "${dep_name}" >&2
    exit 1
  }
  [[ -n "${operator:-}" && -n "${wanted:-}" ]] || continue
  version_satisfies "${have}" "${operator}" "${wanted}" || {
    printf 'error: %s requires %s %s %s, and the pin list has %s\n' \
      "${requester}" "${dep_name}" "${operator}" "${wanted}" "${have}" >&2
    exit 1
  }
done

for record in "${incompatible_with[@]}"; do
  requester="${record%%|*}"
  conflicting="${record#*|}"
  [[ -z "${pinned_versions[${conflicting}]:-}" ]] || {
    printf 'error: %s cannot load beside %s, and both are pinned\n' "${requester}" "${conflicting}" >&2
    exit 1
  }
done

printf 'result=resolved\n'
printf 'payload=%s\n' "${output_dir}"
printf 'resolved=%s\n' "${resolved}"
printf 'downloaded=%s\n' "${downloaded}"
printf 'kept=%s\n' "${kept}"
printf 'engine_check=%s\n' "${engine_series:-skipped}"
printf 'required_dependencies=%s\n' "${#required_deps[@]}"
