#!/usr/bin/env bash

# The session summary is what the machine carries back to whoever asked, and
# the address in it is the strategy's answer — never something the caller
# supplied. Both formats run against a fixture copy of the server tree with
# start.sh replaced by a stub that talks on stdout, which is what proves json
# mode leaves stdout to the document alone.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d /tmp/spawnpoint-session-summary.XXXXXXXX)"
imds_pid=""
cleanup() {
  [[ -n "${imds_pid}" ]] && kill "${imds_pid}" 2>/dev/null
  rm -rf -- "${fixture}"
}
trap cleanup EXIT

mkdir -p -- "${fixture}/server" "${fixture}/bin"
cp -R -- "${REPOSITORY_ROOT}/server/scripts" "${fixture}/server/scripts"
cp -R -- "${REPOSITORY_ROOT}/server/games" "${fixture}/server/games"
cat >"${fixture}/server/scripts/start.sh" <<'STUB'
#!/usr/bin/env bash
printf 'container chatter on stdout\n'
printf 'container chatter on stderr\n' >&2
STUB
cat >"${fixture}/bin/zerotier-cli" <<'STUB'
#!/usr/bin/env bash
printf '[{"nwid":"b6079f73c6698651","status":"OK","assignedAddresses":["172.29.23.24/16"]}]\n'
STUB
chmod +x "${fixture}/server/scripts/start.sh" "${fixture}/bin/zerotier-cli"
printf 'ZEROTIER_NETWORK_ID=b6079f73c6698651\nZEROTIER_ADDRESS=172.29.23.24\n' >"${fixture}/server/.env"
export PATH="${fixture}/bin:${PATH}"
session="${fixture}/server/scripts/start-session.sh"

# --- text stays the stream people read, byte for byte ---
text_output="$("${session}" 2>"${fixture}/text.err")"
grep -Fxq 'connectivity=zerotier' <<<"${text_output}"
grep -Fxq 'connection_host=172.29.23.24' <<<"${text_output}"
grep -Fxq 'connection_address=172.29.23.24:25565' <<<"${text_output}"
grep -Fxq 'zerotier_network=b6079f73c6698651' <<<"${text_output}"
grep -Fxq 'container chatter on stdout' <<<"${text_output}"

# --- json is one document, and nothing else reaches stdout ---
json_output="$(SESSION_FORMAT=json "${session}" 2>"${fixture}/json.err")"
[[ "$(wc -l <<<"${json_output}" | tr -d ' ')" == "1" ]]
jq -e . >/dev/null <<<"${json_output}"
[[ "$(jq -r .connectivity <<<"${json_output}")" == "zerotier" ]]
[[ "$(jq -r .connection_host <<<"${json_output}")" == "172.29.23.24" ]]
[[ "$(jq -r .connection_address <<<"${json_output}")" == "172.29.23.24:25565" ]]
[[ "$(jq -r .zerotier_network <<<"${json_output}")" == "b6079f73c6698651" ]]
[[ "$(jq -r .world <<<"${json_output}")" == "world" ]]
[[ "$(jq -r .desired_release <<<"${json_output}")" == "null" ]]
grep -Fxq 'container chatter on stdout' "${fixture}/json.err"
grep -Fxq 'container chatter on stderr' "${fixture}/json.err"

# --- a raw world's answer is the public address the instance holds ---
python3 - "${fixture}" <<'IMDS' &
import http.server, sys

fixture = sys.argv[1]

class Metadata(http.server.BaseHTTPRequestHandler):
    def do_PUT(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"token-value")
    def do_GET(self):
        if self.headers.get("X-aws-ec2-metadata-token") != "token-value":
            self.send_response(401); self.end_headers(); return
        if self.path != "/latest/meta-data/public-ipv4":
            self.send_response(404); self.end_headers(); return
        self.send_response(200); self.end_headers(); self.wfile.write(b"203.0.113.10")
    def log_message(self, *_args):
        pass

server = http.server.HTTPServer(("127.0.0.1", 0), Metadata)
open(fixture + "/imds-port", "w").write(str(server.server_address[1]))
server.serve_forever()
IMDS
imds_pid=$!
for _ in $(seq 1 50); do
  [[ -s "${fixture}/imds-port" ]] && break
  sleep 0.1
done
jq -n '{
  schema_version: 1,
  profile_source: {repository: "https://example.invalid/profiles", commit: "0000000000000000000000000000000000000000"},
  worlds: [{id: "open", display_name: "Open", profile_id: "open", connectivity: "raw", auth: "external"}]
}' >"${fixture}/catalog.json"
raw_output="$(WORLD_ID=open SPAWNPOINT_WORLD_CATALOG="${fixture}/catalog.json" \
  IMDS_BASE="http://127.0.0.1:$(cat "${fixture}/imds-port")" SESSION_FORMAT=json "${session}" 2>/dev/null)"
[[ "$(jq -r .connectivity <<<"${raw_output}")" == "raw" ]]
[[ "$(jq -r .connection_host <<<"${raw_output}")" == "203.0.113.10" ]]
[[ "$(jq -r .connection_address <<<"${raw_output}")" == "203.0.113.10:25565" ]]
[[ "$(jq -r .world <<<"${raw_output}")" == "open" ]]
[[ "$(jq 'has("zerotier_network")' <<<"${raw_output}")" == "false" ]]

# --- an unknown format is refused before anything runs ---
if SESSION_FORMAT=yaml "${session}" >/dev/null 2>&1; then
  printf 'expected failure: unknown SESSION_FORMAT\n' >&2
  exit 1
fi

printf 'start-session-summary-test: ok\n'
