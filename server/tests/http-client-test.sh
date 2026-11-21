#!/usr/bin/env bash

# The shared HTTP probe (ADR-0076): the client's real requests against a fake
# server that checks basic authentication, and every answer the client must
# refuse: a wrong password, an error status, a redirect, a body that is too
# large, silence, a closed port and an address that is not this host.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
PROBES="${REPOSITORY_ROOT}/server/games/_probes"
fixture="$(mktemp -d /tmp/spawnpoint-http-client-test.XXXXXXXX)"
fake_pid=""
cleanup() {
  if [[ -n "${fake_pid}" ]]; then
    kill "${fake_pid}" 2>/dev/null || true
    wait "${fake_pid}" 2>/dev/null || true
  fi
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

cat >"${fixture}/fake-http.py" <<'FAKE_HTTP'
import base64, http.server, sys, time

directory = sys.argv[1]
EXPECTED = "Basic " + base64.b64encode(b"admin:probe-secret").decode()

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def answer(self, status, body=b"", headers=()):
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def route(self, method):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        with open(directory + "/requests", "a") as log:
            log.write(f"{method} {self.path} {self.headers.get('Content-Type', '-')} {body.decode()}\n")
        if self.headers.get("Authorization") != EXPECTED:
            return self.answer(401)
        if self.path == "/v1/api/metrics" and method == "GET":
            return self.answer(200, b'{"currentplayernum":1,"maxplayernum":32}')
        if self.path == "/v1/api/save" and method == "POST":
            return self.answer(200)
        if self.path == "/v1/api/announce" and method == "POST":
            return self.answer(200, b"announced")
        if self.path == "/error":
            return self.answer(500, b"broken")
        if self.path == "/redirect":
            return self.answer(302, b"", [("Location", "http://example.invalid/steal")])
        if self.path == "/large":
            return self.answer(200, b"x" * (1024 * 1024 + 1))
        if self.path == "/slow":
            time.sleep(3)
            return self.answer(200, b"late")
        return self.answer(404)

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
open(directory + "/port", "w").write(str(server.server_address[1]))
server.serve_forever()
FAKE_HTTP

python3 "${fixture}/fake-http.py" "${fixture}" &
fake_pid=$!
for _ in $(seq 1 50); do
  [[ -s "${fixture}/port" ]] && break
  sleep 0.1
done
port="$(cat "${fixture}/port")"

# Run the client; remember its output and status.
request() {
  status=0
  output="$(python3 "${PROBES}/http-client.py" "$@" 2>"${fixture}/stderr")" || status=$?
}

export HTTP_PROBE_USER=admin HTTP_PROBE_PASSWORD=probe-secret

# --- a GET with the right credentials prints the body as it came ---
request GET "http://127.0.0.1:${port}/v1/api/metrics"
[[ "${status}" == 0 ]]
[[ "${output}" == '{"currentplayernum":1,"maxplayernum":32}' ]]

# --- a POST carries its JSON body; one without a body sends an empty one ---
request POST "http://127.0.0.1:${port}/v1/api/announce" '{"message":"hello"}'
[[ "${status}" == 0 && "${output}" == "announced" ]]
grep -Fxq 'POST /v1/api/announce application/json {"message":"hello"}' "${fixture}/requests"
request POST "http://127.0.0.1:${port}/v1/api/save"
[[ "${status}" == 0 && -z "${output}" ]]
grep -Fxq 'POST /v1/api/save application/json ' "${fixture}/requests"

# --- answers the client does not take ---
HTTP_PROBE_PASSWORD=wrong request GET "http://127.0.0.1:${port}/v1/api/metrics"
[[ "${status}" == 4 && -z "${output}" ]]
grep -q 'status 401' "${fixture}/stderr"
for path in /error /redirect /large /missing; do
  request GET "http://127.0.0.1:${port}${path}"
  [[ "${status}" == 4 ]] || { printf 'path %s: status %s\n' "${path}" "${status}" >&2; exit 1; }
  [[ -z "${output}" ]]
done
# The redirect was not followed.
if grep -q 'steal' "${fixture}/requests"; then exit 1; fi

# --- no answer: a server too slow for the timeout, and a closed port ---
HTTP_PROBE_TIMEOUT_SECONDS=1 request GET "http://127.0.0.1:${port}/slow"
[[ "${status}" == 3 && -z "${output}" ]]
closed_port="$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')"
request GET "http://127.0.0.1:${closed_port}/v1/api/metrics"
[[ "${status}" == 3 ]]

# --- refused before any request: another host, https, no port, no credentials, bad usage ---
for url in "http://192.0.2.1:${port}/v1/api/metrics" "https://127.0.0.1:${port}/" "http://127.0.0.1/v1/api/metrics" "http://example.invalid:${port}/"; do
  request GET "${url}"
  [[ "${status}" == 2 ]] || { printf 'url %s: status %s\n' "${url}" "${status}" >&2; exit 1; }
done
HTTP_PROBE_PASSWORD="" request GET "http://127.0.0.1:${port}/v1/api/metrics"
[[ "${status}" == 2 ]]
request DELETE "http://127.0.0.1:${port}/v1/api/metrics"
[[ "${status}" == 2 ]]
request GET "http://127.0.0.1:${port}/v1/api/metrics" '{"body":"on a GET"}'
[[ "${status}" == 2 ]]
request GET
[[ "${status}" == 2 ]]

# --- the shell helper: the secret from the environment, else the host .env ---
unset HTTP_PROBE_USER HTTP_PROBE_PASSWORD
# shellcheck source=../games/_probes/http.sh
source "${PROBES}/http.sh"
[[ "$(TEST_PROBE_SECRET=from-env http_probe_secret TEST_PROBE_SECRET)" == "from-env" ]]
printf 'OTHER=x\nTEST_PROBE_SECRET=probe-secret\n' >"${fixture}/runtime.env"
[[ "$(SERVER_ENV_FILE="${fixture}/runtime.env" http_probe_secret TEST_PROBE_SECRET)" == "probe-secret" ]]
if SERVER_ENV_FILE="${fixture}/missing.env" http_probe_secret TEST_PROBE_SECRET >/dev/null 2>&1; then exit 1; fi
[[ "$(SERVER_ENV_FILE="${fixture}/runtime.env" http_probe_request GET "${port}" /v1/api/metrics admin TEST_PROBE_SECRET)" == '{"currentplayernum":1,"maxplayernum":32}' ]]
status=0
SERVER_ENV_FILE="${fixture}/missing.env" http_probe_request GET "${port}" /v1/api/metrics admin TEST_PROBE_SECRET >/dev/null 2>&1 || status=$?
[[ "${status}" == 2 ]]

printf 'http-client-test: ok\n'
