#!/usr/bin/env bash

# The HTTP probe transport (ADR-0076), shared by every game whose server
# answers its own HTTP API. A game module sources this file and names the
# port, the path, the user and the host .env key that holds the password;
# the client is the same for all of them. Each game keeps its own parser.
#
# shellcheck shell=bash

HTTP_PROBE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

# A credential from the environment, else from the host's runtime .env, where
# the image reads it too. Never from a world setting.
http_probe_secret() {
  local name="$1"
  if [[ -n "${!name:-}" ]]; then
    printf '%s' "${!name}"
    return 0
  fi
  local env_file="${SERVER_ENV_FILE:-${HTTP_PROBE_DIR}/../../.env}"
  [[ -f "${env_file}" ]] || return 1
  awk -F= -v key="${name}" '$1 == key { print substr($0, index($0, "=") + 1); found = 1; exit }
    END { if (!found) exit 1 }' "${env_file}"
}

# One request to 127.0.0.1:<port><path>; the body is printed, the status is
# the client's. The password reaches the client in its environment only.
http_probe_request() {
  local method="$1" port="$2" path="$3" user="$4" secret_name="$5"
  shift 5
  local password
  password="$(http_probe_secret "${secret_name}")" || password=""
  if [[ -z "${password}" ]]; then
    printf 'error: %s is not set in the environment or the runtime .env\n' "${secret_name}" >&2
    return 2
  fi
  HTTP_PROBE_USER="${user}" HTTP_PROBE_PASSWORD="${password}" \
    python3 "${HTTP_PROBE_DIR}/http-client.py" "${method}" "http://127.0.0.1:${port}${path}" "$@"
  return $?
}
