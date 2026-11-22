#!/usr/bin/env bash

# Holders for the catalog (ADR-0080): a release that a catalog lists gets a
# `catalog` holder in the reference table before the catalog is written, so a
# retirement cannot take it from under the catalog. Both catalog builders use it.
# shellcheck shell=bash
# shellcheck disable=SC2154 # repository_root is set by the sourcing builder

# Holds each release of <catalog-file> for <game>. Stops on the first failure,
# so the caller does not write the catalog. Without the writer (a workstation
# run) it skips and says so.
hold_catalog_releases() {
  local catalog_file="$1" game="$2" id releases
  local -a writer=()
  if [[ -n "${RELEASE_WRITER_BIN:-}" ]]; then
    # Tests point the builders at a stub; the value is a command line.
    read -r -a writer <<<"${RELEASE_WRITER_BIN}"
  elif [[ -f "${repository_root}/tools/release-writer.cjs" ]]; then
    writer=(node "${repository_root}/tools/release-writer.cjs")
  else
    printf 'catalog_holders=skipped_no_tool\n'
    return 0
  fi
  while IFS=$'\t' read -r id releases; do
    [[ -n "${releases}" ]] || continue
    RELEASE_BUCKET="${RELEASE_BUCKET}" "${writer[@]}" hold-catalog --game "${game}" --preset "${id}" --releases "${releases}" >/dev/null || {
      printf 'error: could not hold the catalog releases of %s\n' "${id}" >&2
      return 1
    }
  done < <(jq -r '.presets[] | [.id, ((.releases // []) | join(","))] | @tsv' "${catalog_file}")
  printf 'catalog_holders=held\n'
}
