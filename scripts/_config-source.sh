#!/usr/bin/env bash

# Materialize an inert, content-addressed snapshot uploaded by the trusted
# GitHub Actions identity. This supports private config repositories without
# giving CodeBuild a long-lived GitHub credential.

materialize_config_source() {
  local workspace="$1"
  local repository_slug expected_key archive member

  [[ "${CONFIG_SOURCE_SHA256:-}" =~ ^[0-9a-f]{64}$ ]] || {
    printf 'error: CONFIG_SOURCE_SHA256 must be a lowercase SHA-256\n' >&2
    return 1
  }

  case "${CONFIG_REPOSITORY_URL}" in
    https://github.com/DrArzter/my-docker-minecraft-server-config | \
    https://github.com/DrArzter/my-docker-minecraft-server-config.git)
      repository_slug="DrArzter/my-docker-minecraft-server-config"
      ;;
    https://github.com/DrArzter/my-docker-factorio-server-config | \
    https://github.com/DrArzter/my-docker-factorio-server-config.git)
      repository_slug="DrArzter/my-docker-factorio-server-config"
      ;;
    https://github.com/DrArzter/my-docker-zomboid-server-config | \
    https://github.com/DrArzter/my-docker-zomboid-server-config.git)
      repository_slug="DrArzter/my-docker-zomboid-server-config"
      ;;
    *)
      printf 'error: untrusted CONFIG_REPOSITORY_URL: %s\n' "${CONFIG_REPOSITORY_URL}" >&2
      return 1
      ;;
  esac

  expected_key="config-sources/${repository_slug}/${CONFIG_COMMIT}.tar.gz"
  [[ "${CONFIG_SOURCE_KEY:-}" == "${expected_key}" ]] || {
    printf 'error: CONFIG_SOURCE_KEY does not match repository and commit\n' >&2
    return 1
  }

  archive="${workspace}/config-source.tar.gz"
  aws s3api get-object \
    --bucket "${RELEASE_BUCKET}" \
    --key "${CONFIG_SOURCE_KEY}" \
    "${archive}" >/dev/null
  printf '%s  %s\n' "${CONFIG_SOURCE_SHA256}" "${archive}" | sha256sum -c - >/dev/null

  while IFS= read -r member; do
    case "${member}" in
      profiles | profiles/ | profiles/*) ;;
      *)
        printf 'error: config snapshot contains an unexpected path: %s\n' "${member}" >&2
        return 1
        ;;
    esac
  done < <(tar -tzf "${archive}")

  CONFIG_CHECKOUT="${workspace}/config"
  mkdir -p -- "${CONFIG_CHECKOUT}"
  tar -xzf "${archive}" --no-same-owner --no-same-permissions -C "${CONFIG_CHECKOUT}"
  if find "${CONFIG_CHECKOUT}" -type l -print -quit | grep -q .; then
    printf 'error: config snapshot must not contain symbolic links\n' >&2
    return 1
  fi
}
