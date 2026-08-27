#!/usr/bin/env bash

# Adoption helper (docs/runbook.md): a factorio mods directory IS the mod set
# — files are name_version.zip straight from the portal — so a profile's pin
# list is a pure function of it. Prints name:version lines (resolve-mods.sh's
# own contract) to stdout, and refuses a file it cannot pin rather than
# silently dropping a mod from the derived profile.

set -Eeuo pipefail

[[ $# -eq 1 ]] || {
  printf 'usage: %s <mods-dir>\n' "$0" >&2
  exit 2
}
mods_dir="$1"
[[ -d "${mods_dir}" ]] || {
  printf 'error: mods directory does not exist: %s\n' "${mods_dir}" >&2
  exit 1
}

pins=()
unpinnable=()
while IFS= read -r -d '' zip; do
  file_name="$(basename -- "${zip}")"
  if [[ "${file_name}" =~ ^([A-Za-z0-9_-]+)_([0-9]+(\.[0-9]+)*)\.zip$ ]]; then
    pins+=("${BASH_REMATCH[1]}:${BASH_REMATCH[2]}")
  else
    unpinnable+=("${file_name}")
  fi
done < <(find "${mods_dir}" -maxdepth 1 -type f -name '*.zip' -print0 | sort -z)

(( ${#unpinnable[@]} == 0 )) || {
  printf 'error: cannot derive a pin from:\n' >&2
  printf '  %s\n' "${unpinnable[@]}" >&2
  exit 1
}

if (( ${#pins[@]} > 0 )); then
  printf '%s\n' "${pins[@]}"
fi
