#!/usr/bin/env bash

# The release plan: what a new release changes compared with the previous
# release of its preset. It is descriptive and never part of the release
# identity; the builder runs it after the manifest exists and never stops a
# build because of it. The API diffs two manifests with the same model
# (lambdas/src/control-plane/release-plan.ts); both read the shared fixtures in
# server/tests/fixtures/release-plan.

set -Eeuo pipefail

# shellcheck source=../games/_legacy-game.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/../games/_legacy-game.sh"

usage() {
  cat >&2 <<'EOF'
usage: plan-release.sh <new-manifest> <previous-manifest | none>

Writes the plan as JSON to RELEASE_PLAN_OUTPUT (default: plan.json beside the
new manifest) and prints key=value summary lines and up to
RELEASE_PLAN_LOG_ENTRIES (default 50) named entries.
EOF
}

[[ $# -eq 2 ]] || {
  usage
  exit 2
}

command -v jq >/dev/null 2>&1 || {
  printf 'error: required command not found: jq\n' >&2
  exit 1
}

new_manifest="$(realpath -e -- "$1")"
previous_manifest="$2"
output="$(realpath -m -- "${RELEASE_PLAN_OUTPUT:-$(dirname -- "${new_manifest}")/plan.json}")"
log_entries="${RELEASE_PLAN_LOG_ENTRIES:-50}"
[[ "${log_entries}" =~ ^[0-9]+$ ]] || {
  printf 'error: RELEASE_PLAN_LOG_ENTRIES must be a number: %s\n' "${log_entries}" >&2
  exit 1
}

# Only what the plan reads; upload-release.sh owns the full shape check.
manifest_shape='
  .schema_version == 1 and
  (.release | type == "string") and
  (.server.mods | type == "array") and
  all(.server.mods[]; (.file | type == "string") and (.sha256 | type == "string") and (.bytes | type == "number"))
'
jq -e "${manifest_shape}" "${new_manifest}" >/dev/null || {
  printf 'error: not a release manifest: %s\n' "${new_manifest}" >&2
  exit 1
}
if [[ "${previous_manifest}" == none ]]; then
  previous_manifest=/dev/null
else
  previous_manifest="$(realpath -e -- "${previous_manifest}")"
  jq -e "${manifest_shape}" "${previous_manifest}" >/dev/null || {
    printf 'error: not a release manifest: %s\n' "${previous_manifest}" >&2
    exit 1
  }
fi

# Pairing order, per list: the same name (unchanged or changed), then the same
# digest under another name (unchanged), then a shared mod id when both
# manifests carry mod_index (changed). What is left is removed or added.
read -r -d '' plan_program <<'JQ' || true
def entry($m):
  {file, sha256, bytes}
  + (if .side then {side} else {} end)
  + (if $m.mod_index then {mod_ids: ($m.mod_index[.sha256] // [])} else {} end);

def server_mods($m):
  (($m.client.addons // []) | map({key: .file, value: .side}) | from_entries) as $sides |
  [$m.server.mods[] | (if $sides[.file] then . + {side: $sides[.file]} else . end) | entry($m)];

# Files players get that the server does not run: the client-only part of a
# players set (ADR-0069) and client addons (ADR-0077).
def client_only($m):
  [$m.server.mods[].file] as $server |
  if $m.client.kind == "mod-set" then
    [$m.client.mods[] | select(.file as $f | any($server[]; . == $f) | not) | entry($m)]
  else
    [($m.client.addons // [])[] | select(.side == "client") | entry($m)]
  end;

def pair($olds; $news; condition):
  reduce $olds[] as $o ({pairs: [], olds: [], news: $news};
    (first(range(0; .news | length) as $i | select([$o, .news[$i]] | condition) | $i) // null) as $i |
    if $i == null then .olds += [$o]
    else .pairs += [[$o, .news[$i]]] | .news |= (.[:$i] + .[$i + 1:]) end);

def classes($old; $new; $by_id):
  pair($old; $new; .[0].file == .[1].file) as $by_name |
  pair($by_name.olds; $by_name.news; .[0].sha256 == .[1].sha256) as $by_digest |
  (if $by_id then
    pair($by_digest.olds; $by_digest.news;
      (.[0].mod_ids // []) as $a | any((.[1].mod_ids // [])[]; . as $id | any($a[]; . == $id)))
  else {pairs: [], olds: $by_digest.olds, news: $by_digest.news} end) as $by_mod |
  ($by_name.pairs | map(select(.[0].sha256 != .[1].sha256))) as $renamed_bytes |
  {
    added: ($by_mod.news | sort_by(.file)),
    removed: ($by_mod.olds | sort_by(.file)),
    changed: (($renamed_bytes + $by_mod.pairs) | map({from: .[0], to: .[1]}) | sort_by(.to.file, .from.file)),
    unchanged: (($by_name.pairs | map(select(.[0].sha256 == .[1].sha256)) | length) + ($by_digest.pairs | length))
  };

def overrides($m): [($m.server.overrides // [])[] | {path, sha256, bytes}];

def override_roots($old; $new):
  ([$old[], $new[]] | map(.path | split("/")[0]) | unique) as $roots |
  [$roots[] as $root |
    [$old[] | select(.path | split("/")[0] == $root)] as $o |
    [$new[] | select(.path | split("/")[0] == $root)] as $n |
    ($o | map({key: .path, value: .}) | from_entries) as $by_old |
    ($n | map({key: .path, value: .}) | from_entries) as $by_new |
    {
      root: $root,
      added: [$n[] | select($by_old[.path] == null)],
      removed: [$o[] | select($by_new[.path] == null)],
      changed: [$n[] | select($by_old[.path] != null and $by_old[.path].sha256 != .sha256) |
        {from: $by_old[.path], to: .}],
      unchanged: ([$n[] | select($by_old[.path] != null and $by_old[.path].sha256 == .sha256)] | length)
    }];

def value_change($from; $to; $first): {from: $from, to: $to, changed: (($first | not) and $from != $to)};

def pack($m): if $m.client.kind == "curseforge-modpack" then {sha256: $m.client.sha256, bytes: $m.client.bytes} else null end;

$new[0] as $n |
($previous | if length == 0 then null else .[0] end) as $p |
($p == null) as $first |
($p // {server: {mods: []}}) as $o |
((($n.mod_index // null) != null) and (($o.mod_index // null) != null)) as $by_id |
{
  schema_version: 1,
  game: ($n.game // $legacy_game),
  preset: ($n.source_profile.id // null),
  release: $n.release,
  previous_release: (if $first then null else $o.release end),
  matched_by: (if $first then null elif $by_id then "mod_id" else "file_name" end),
  minecraft: value_change($o.minecraft_version // null; $n.minecraft_version // null; $first),
  loader: value_change($o.loader // null; $n.loader // null; $first),
  runtime: value_change($o.runtime.image // null; $n.runtime.image // null; $first),
  server_mods: classes(server_mods($o); server_mods($n); $by_id),
  server_overrides: {roots: override_roots(overrides($o); overrides($n))},
  client_mods: classes(client_only($o); client_only($n); $by_id),
  client_pack: value_change(pack($o); pack($n); $first)
}
JQ

output_tmp="$(mktemp "$(dirname -- "${output}")/.plan.XXXXXX")"
trap 'rm -f -- "${output_tmp}"' EXIT
jq -n --arg legacy_game "${LEGACY_GAME_ID}" --slurpfile new "${new_manifest}" --slurpfile previous "${previous_manifest}" "${plan_program}" >"${output_tmp}"
chmod 0644 "${output_tmp}"
mv -- "${output_tmp}" "${output}"

# The log: counts first, then the named entries most worth a look (removals,
# then changes, then additions), so a truncated list still shows the losses.
jq -r --argjson limit "${log_entries}" '
  def total($section; $class): [$section.roots[]?[$class] | length] | add // 0;
  def mod_name: .file + (if (.mod_ids // []) == [] then "" else " [" + (.mod_ids | join(",")) + "]" end);
  def entries:
    [
      (.server_mods.removed[] | "removed server_mod " + mod_name),
      (.client_mods.removed[] | "removed client_mod " + mod_name),
      (.server_mods.changed[] | "changed server_mod " + (.from | mod_name) + " -> " + (.to | mod_name)),
      (.client_mods.changed[] | "changed client_mod " + (.from | mod_name) + " -> " + (.to | mod_name)),
      (.server_overrides.roots[] | .removed[] | "removed override " + .path),
      (.server_overrides.roots[] | .changed[] | "changed override " + .to.path),
      (.server_mods.added[] | "added server_mod " + mod_name),
      (.client_mods.added[] | "added client_mod " + mod_name),
      (.server_overrides.roots[] | .added[] | "added override " + .path)
    ];
  def change($name; $value): if $value.changed then "plan_\($name)=\($value.from | tojson) -> \($value.to | tojson)" else empty end;
  (if .previous_release == null then "plan=first_release" else "plan=compared", "plan_previous_release=\(.previous_release)", "plan_matched_by=\(.matched_by)" end),
  "plan_release=\(.release)",
  change("minecraft"; .minecraft), change("loader"; .loader), change("runtime"; .runtime),
  "plan_mods_added=\(.server_mods.added | length)",
  "plan_mods_removed=\(.server_mods.removed | length)",
  "plan_mods_changed=\(.server_mods.changed | length)",
  "plan_mods_unchanged=\(.server_mods.unchanged)",
  "plan_overrides_added=\(total(.server_overrides; "added"))",
  "plan_overrides_removed=\(total(.server_overrides; "removed"))",
  "plan_overrides_changed=\(total(.server_overrides; "changed"))",
  "plan_client_mods_added=\(.client_mods.added | length)",
  "plan_client_mods_removed=\(.client_mods.removed | length)",
  "plan_client_mods_changed=\(.client_mods.changed | length)",
  "plan_client_pack_changed=\(.client_pack.changed)",
  (if .previous_release == null then empty else
    entries as $all |
    ($all[:$limit][] | "plan_entry=" + .),
    (if ($all | length) > $limit then "plan_entries_omitted=\(($all | length) - $limit)" else empty end)
  end)
' "${output}"
printf 'plan_file=%s\n' "${output}"
