#!/usr/bin/env bash

# Checks resolved addons against the modpack they extend (ADR-0077), before any
# of them enters a release: C1 loader and Minecraft, C2 file name, C3
# CurseForge project, C4 mod id, C5 disabled in the pack (warning), C6 required
# dependencies, C7 declared breaks, C8 side. It runs on the server set (pack
# server JARs + both + server) and on the client set (pack client JARs + both +
# client), then checks config.replaces and writes the descriptive mod_index.
#
# Mod metadata is read from each JAR as data (fabric.mod.json, quilt.mod.json,
# META-INF/mods.toml, META-INF/neoforge.mods.toml); nothing in a JAR is run.
# Version ranges are read only for Minecraft (C1) and breaks (C7); C6 checks
# that a dependency is present, not its version.

set -Eeuo pipefail
shopt -s inherit_errexit

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=_common.sh
source "${SCRIPT_DIR}/_common.sh"

pack_dir="${1:-}"
addons_dir="${2:-}"
[[ -n "${pack_dir}" && -n "${addons_dir}" ]] ||
  die "usage: check-mod-set.sh <modpack-resolver-output> <addons-resolver-output>"
for command in find jq realpath sha256sum unzip; do
  require_command "${command}"
done
minecraft_version="${CHECK_MINECRAFT_VERSION:-}"
loader_type="${CHECK_LOADER_TYPE:-}"
[[ -n "${minecraft_version}" && -n "${loader_type}" ]] ||
  die "CHECK_MINECRAFT_VERSION and CHECK_LOADER_TYPE are required"
case "${loader_type}" in
  fabric) metadata_files=(fabric.mod.json) ;;
  quilt) metadata_files=(quilt.mod.json fabric.mod.json) ;;
  forge) metadata_files=(META-INF/mods.toml) ;;
  neoforge) metadata_files=(META-INF/neoforge.mods.toml META-INF/mods.toml) ;;
  *) die "addons need a mod loader, not ${loader_type}" ;;
esac

pack_dir="$(realpath -e -- "${pack_dir}")"
addons_dir="$(realpath -e -- "${addons_dir}")"
lock="${addons_dir}/addons-lock.json"
[[ -d "${pack_dir}/mods" && -f "${pack_dir}/client.zip" ]] || die "modpack resolver output is incomplete: ${pack_dir}"
[[ -f "${lock}" ]] || die "addons lock is missing: ${lock}"

workspace="$(mktemp -d)"
cleanup() {
  rm -rf -- "${workspace}"
}
trap cleanup EXIT
mkdir -p -- "${workspace}/meta" "${workspace}/client-pack"
rows="${workspace}/rows"

warnings=0
warn() {
  printf 'warning: %s\n' "$*" >&2
  warnings=$((warnings + 1))
}
failures="${workspace}/failures"
: >"${failures}"
refuse() {
  printf 'error: %s\n' "$*" >&2
  printf '%s\n' "$*" >>"${failures}"
}

# Version arithmetic for numeric dotted versions. Each matcher answers true,
# false, or null when the range or the version cannot be read.
# shellcheck disable=SC2016 # jq source, not shell
readonly VERSIONS='
def vnums: sub("\\+.*$"; "") | if test("^[0-9]+(\\.[0-9]+)*$") then split(".") | map(tonumber) else null end;
def vcmp($a; $b): ([($a | length), ($b | length)] | max) as $n |
  reduce range(0; $n) as $i (0; if . != 0 then . else
    (($a[$i] // 0) - ($b[$i] // 0)) | if . < 0 then -1 elif . > 0 then 1 else 0 end end);
def all3: if any(. == false) then false elif any(. == null) then null else true end;
def any3: if any(. == true) then true elif any(. == null) then null else false end;
def fabric_predicate($v):
  if . == "*" then true
  else capture("^(?<op>>=|<=|>|<|=|~|\\^)?(?<ver>.+)$") as $p |
    ($p.op // "=") as $op |
    if ($p.ver | test("^[0-9]+(\\.[0-9]+)*\\.[xX*]$")) then
      ($p.ver | sub("\\.[xX*]$"; "") | split(".") | map(tonumber)) as $prefix |
      if $op == "=" then ($v[0:($prefix | length)] == $prefix) else null end
    elif ($p.ver | vnums) == null then null
    else ($p.ver | vnums) as $w | vcmp($v; $w) as $c |
      if $op == "=" then $c == 0
      elif $op == ">=" then $c >= 0
      elif $op == ">" then $c > 0
      elif $op == "<=" then $c <= 0
      elif $op == "<" then $c < 0
      elif $op == "~" then $c >= 0 and vcmp($v; (if ($w | length) >= 2 then [$w[0], $w[1] + 1] else [$w[0] + 1] end)) < 0
      else $c >= 0 and vcmp($v; [$w[0] + 1]) < 0
      end
    end
  end;
# Fabric and Quilt: a string of space-separated predicates (all must hold), or
# an array of such strings (any may hold).
def fabric_range($v):
  if $v == null then null
  elif type == "string" then [split(" ")[] | select(. != "") | fabric_predicate($v)] | if length == 0 then true else all3 end
  elif type == "array" then map(fabric_range($v)) | if length == 0 then true else any3 end
  else null end;
# Forge and NeoForge: Maven ranges. A bare version is a soft requirement.
def maven_range($v):
  if $v == null or type != "string" then null
  elif (gsub(" "; "") | test("^[0-9]+(\\.[0-9]+)*$")) or . == "*" or . == "" then true
  else [scan("[\\[(][^\\])]*[\\])]")] as $ranges |
    if ($ranges | length) == 0 then null else
      $ranges | map(
        .[0:1] as $open | .[-1:] as $close | (.[1:-1] | gsub(" "; "") | split(",")) as $bounds |
        if ($bounds | length) == 1 then
          ($bounds[0] | vnums) as $x | if $x == null then null else vcmp($v; $x) == 0 end
        elif ($bounds | length) == 2 then
          [(if $bounds[0] == "" then true else ($bounds[0] | vnums) as $l |
             if $l == null then null elif $open == "[" then vcmp($v; $l) >= 0 else vcmp($v; $l) > 0 end end),
           (if $bounds[1] == "" then true else ($bounds[1] | vnums) as $h |
             if $h == null then null elif $close == "]" then vcmp($v; $h) <= 0 else vcmp($v; $h) < 0 end end)] | all3
        else null end) | any3
    end
  end;
def range_matches($syntax; $version):
  ($version | if type == "string" then vnums else null end) as $v |
  if $syntax == "maven" then maven_range($v) else fabric_range($v) end;
def common($a; $b): [$a[] | select(. as $x | $b | index($x))] | unique;
'

# The ids a loader provides itself; never another mod's job.
readonly BUILTIN_IDS='["minecraft","java","fabricloader","fabric-loader","quilt_loader","quilt-loader","forge","neoforge","fml","javafml"]'

# Forge-style TOML, the subset mod metadata uses: one "<block>\t<n>\t<key>\t<value>"
# line per scalar in [[mods]] and [[dependencies.*]] tables.
toml_records() {
  awk '
    function unquote(v) {
      if (v ~ /^"/) { sub(/^"/, "", v); sub(/".*$/, "", v); return v }
      if (v ~ /^\047/) { sub(/^\047/, "", v); sub(/\047.*$/, "", v); return v }
      sub(/[ \t]*#.*$/, "", v); sub(/[ \t]+$/, "", v); return v
    }
    BEGIN { block = ""; n = 0; open = "" }
    {
      line = $0; sub(/\r$/, "", line); sub(/^[ \t]+/, "", line)
      if (open != "") { if (index(line, open) > 0) open = ""; next }
      if (line == "" || line ~ /^#/) next
      if (line ~ /^\[\[mods\]\]/) { block = "mods"; n++; next }
      if (line ~ /^\[\[dependencies\./) { block = "dep"; n++; next }
      if (line ~ /^\[/) { block = ""; next }
      if (block == "" || line !~ /^[A-Za-z_][A-Za-z0-9_]*[ \t]*=/) next
      key = line; sub(/[ \t]*=.*$/, "", key)
      value = line; sub(/^[^=]*=[ \t]*/, "", value)
      if (value ~ /^(\047\047\047|""")/) {
        delimiter = substr(value, 1, 3)
        if (index(substr(value, 4), delimiter) == 0) open = delimiter
        next
      }
      printf "%s\t%d\t%s\t%s\n", block, n, key, unquote(value)
    }'
}

# One JAR's metadata for this loader, as JSON. Nested JARs are read to the
# depth given, so a library a mod ships inside itself counts as present.
# readable is false only when the loader's metadata file exists but cannot be read.
describe_jar() {
  local jar="$1" depth="$2" listing format="" file raw="" nested_list nested_path nested_file nested_json version
  local nested_ids="[]"
  listing="$(unzip -Z1 "${jar}" 2>/dev/null)" || {
    printf '{"readable":false,"ids":[],"nested_ids":[]}\n'
    return 0
  }
  for file in "${metadata_files[@]}"; do
    if grep -Fxq -- "${file}" <<<"${listing}"; then
      format="${file}"
      break
    fi
  done
  case "${format}" in
    "")
      printf '{"readable":true,"format":null,"ids":[],"nested_ids":[]}\n'
      return 0
      ;;
    fabric.mod.json)
      raw="$(unzip -p "${jar}" fabric.mod.json | jq -c '
        {format: "fabric", ids: ([.id] + [(.provides // [])[] | if type == "string" then . else .id end]),
          version: (.version // null),
          depends: [(.depends // {}) | keys[]],
          breaks: [(.breaks // {}) | to_entries[] | {id: .key, range: .value, syntax: "fabric"}],
          minecraft: (if (.depends // {}) | has("minecraft") then {range: .depends.minecraft, syntax: "fabric"} else null end),
          nested: [(.jars // [])[] | .file? // empty]}' 2>/dev/null)" || raw=""
      ;;
    quilt.mod.json)
      raw="$(unzip -p "${jar}" quilt.mod.json | jq -c '
        .quilt_loader as $q |
        def entry: if type == "string" then {id: ., versions: "*"} else {id: .id, versions: (.versions // "*"), optional: (.optional // false)} end;
        {format: "quilt", ids: ([$q.id] + [($q.provides // [])[] | if type == "string" then . else .id end]),
          version: ($q.version // null),
          depends: [($q.depends // [])[] | entry | select(.optional != true) | .id],
          breaks: [($q.breaks // [])[] | entry | {id, range: .versions, syntax: "fabric"}],
          minecraft: ([($q.depends // [])[] | entry | select(.id == "minecraft") | {range: .versions, syntax: "fabric"}][0] // null),
          nested: [($q.jars // [])[] | strings]}' 2>/dev/null)" || raw=""
      ;;
    *)
      raw="$(unzip -p "${jar}" "${format}" | toml_records | jq -Rsc '
        [split("\n")[] | select(. != "") | split("\t") | {block: .[0], n: .[1], key: .[2], value: .[3]}] |
        group_by(.n) | map({block: .[0].block} + (map({key, value}) | from_entries)) as $tables |
        ($tables | map(select(.block == "dep"))) as $deps |
        {format: "forge",
          ids: [$tables[] | select(.block == "mods") | .modId // empty],
          version: ([$tables[] | select(.block == "mods") | .version // empty][0] // null),
          depends: [$deps[] | select(.mandatory == "true" or .type == "required") | .modId // empty],
          breaks: [$deps[] | select(.type == "incompatible") | {id: .modId, range: (.versionRange // ""), syntax: "maven"}],
          minecraft: ([$deps[] | select(.modId == "minecraft") | {range: (.versionRange // ""), syntax: "maven"}][0] // null),
          nested: []}' 2>/dev/null)" || raw=""
      if [[ -n "${raw}" ]] && grep -Fxq -- META-INF/jarjar/metadata.json <<<"${listing}"; then
        nested_list="$(unzip -p "${jar}" META-INF/jarjar/metadata.json | jq -c '[.jars[]?.path | strings]' 2>/dev/null)" || nested_list="[]"
        raw="$(jq -c --argjson nested "${nested_list}" '.nested = $nested' <<<"${raw}")"
      fi
      # A Forge mod usually takes its version from the JAR manifest.
      if [[ -n "${raw}" ]] && jq -e '.version | strings | startswith("${")' <<<"${raw}" >/dev/null; then
        version="$(unzip -p "${jar}" META-INF/MANIFEST.MF 2>/dev/null |
          awk -F': *' '$1 == "Implementation-Version" { sub(/\r$/, "", $2); print $2; exit }')" || version=""
        raw="$(jq -c --arg version "${version}" '.version = (if $version == "" then null else $version end)' <<<"${raw}")"
      fi
      ;;
  esac
  [[ -n "${raw}" ]] || {
    printf '{"readable":false,"format":null,"ids":[],"nested_ids":[]}\n'
    return 0
  }
  if (( depth > 0 )); then
    while IFS= read -r nested_path; do
      [[ -n "${nested_path}" && "${nested_path}" != /* && "${nested_path}" != *..* ]] || continue
      nested_file="$(mktemp -p "${workspace}")"
      if unzip -p "${jar}" "${nested_path}" >"${nested_file}" 2>/dev/null && [[ -s "${nested_file}" ]]; then
        nested_json="$(describe_jar "${nested_file}" $((depth - 1)))"
        nested_ids="$(jq -c --argjson more "${nested_json}" '. + $more.ids + $more.nested_ids | unique' <<<"${nested_ids}")"
      fi
      rm -f -- "${nested_file}"
    done < <(jq -r '.nested[]' <<<"${raw}")
  fi
  jq -c --argjson nested_ids "${nested_ids}" \
    '{readable: true} + del(.nested) + {ids: (.ids | map(strings | select(. != "")) | unique), nested_ids: $nested_ids}' <<<"${raw}"
}

# Metadata once per distinct file, whichever set it is in.
describe_cached() {
  local jar="$1" digest cache
  digest="$(sha256sum -- "${jar}")"
  digest="${digest%% *}"
  cache="${workspace}/meta/${digest}.json"
  if [[ ! -s "${cache}" ]]; then
    describe_jar "${jar}" 3 | jq -c --arg sha256 "${digest}" '. + {sha256: $sha256}' >"${cache}.tmp"
    [[ -s "${cache}.tmp" ]] || die "could not describe ${jar}"
    mv -- "${cache}.tmp" "${cache}"
  fi
  printf '%s\n' "${cache}"
}

# One JSONL record per JAR of a set: {file, origin, side, name, project_id, ...metadata}.
records_for() {
  local origin="$1" side="$2" directory="$3" jar cache
  [[ -d "${directory}" ]] || return 0
  while IFS= read -r -d '' jar; do
    cache="$(describe_cached "${jar}")"
    jq -c --arg file "$(basename -- "${jar}")" --arg origin "${origin}" --arg side "${side}" --slurpfile lock "${lock}" '
      (if $origin == "addon" then ([$lock[0].mods[] | select(.file == $file)][0] // {}) else {} end) as $entry |
      {file: $file, origin: $origin, side: $side, name: ($entry.name // null),
        project_id: ($entry.source.curseforge.project_id // null)} + .
    ' "${cache}"
  done < <(find "${directory}" -maxdepth 1 -type f -iname '*.jar' -print0 | sort -z)
}

# The client pack's own JARs and override paths, read from the resolver's archive.
client_overrides="$(unzip -p "${pack_dir}/client.zip" manifest.json | jq -er '.overrides | select(test("^[A-Za-z0-9_-]+$"))')" ||
  die "the modpack client pack has no readable manifest"
unzip -qo "${pack_dir}/client.zip" "${client_overrides}/mods/*" -d "${workspace}/client-pack" 2>/dev/null || true
pack_lock="${workspace}/client-lock.json"
unzip -p "${pack_dir}/client.zip" spawnpoint-client-lock.json >"${pack_lock}" 2>/dev/null || printf '{"files":[]}' >"${pack_lock}"

server_set="${workspace}/server-set.jsonl"
client_set="${workspace}/client-set.jsonl"
{
  records_for pack server "${pack_dir}/mods"
  records_for addon both "${addons_dir}/both"
  records_for addon server "${addons_dir}/server"
} >"${server_set}"
{
  records_for pack client "${workspace}/client-pack/${client_overrides}/mods"
  records_for addon both "${addons_dir}/both"
  records_for addon client "${addons_dir}/client"
} >"${client_set}"
[[ "$(jq -s 'map(select(.origin == "addon")) | unique_by(.file) | length' "${server_set}" "${client_set}")" == \
  "$(jq '.mods | length' "${lock}")" ]] || die "the addons output does not match its lock"

jq -rs 'map(select(.origin == "pack" and .readable == false)) | unique_by(.file)[] | .file' \
  "${server_set}" "${client_set}" >"${rows}"
while IFS= read -r file; do
  warn "cannot read the mod metadata of pack file ${file}; C4, C6 and C7 do not see it"
done <"${rows}"

# C1, once per addon: metadata for this loader, and a Minecraft range that
# admits the profile's version. Tab-separated rows never carry an empty field
# before the last, because read collapses adjacent tabs.
jq -rs --arg minecraft "${minecraft_version}" "${VERSIONS}"'
  map(select(.origin == "addon")) | unique_by(.file)[] |
  [.file, .name, (.readable | tostring), (.format // "none"),
    (if .minecraft == null then "true" else (.minecraft as $m | $m.range | range_matches($m.syntax; $minecraft) | tostring) end)] | @tsv
' "${server_set}" "${client_set}" >"${rows}"
while IFS=$'\t' read -r file name readable format verdict; do
  if [[ "${readable}" != true || "${format}" == none ]]; then
    refuse "C1 addon \"${name}\" (${file}) has no readable ${loader_type} mod metadata"
  elif [[ "${verdict}" == false ]]; then
    refuse "C1 addon \"${name}\" (${file}) does not support Minecraft ${minecraft_version}"
  elif [[ "${verdict}" == null ]]; then
    warn "C1 addon \"${name}\" (${file}): cannot read its Minecraft range; the server start is the proof"
  fi
done <"${rows}"

# C3: a CurseForge project the pack already resolves.
jq -rs --slurpfile pack "${pack_lock}" '
  [$pack[0].files[]?.project_id] as $projects |
  map(select(.origin == "addon" and .project_id != null)) | unique_by(.file)[] |
  select(.project_id as $p | $projects | index($p)) | [.name, (.project_id | tostring)] | @tsv
' "${server_set}" "${client_set}" >"${rows}"
while IFS=$'\t' read -r name project; do
  refuse "C3 addon \"${name}\": the pack already has CurseForge project ${project}"
done <"${rows}"

# C4 between addons: two addons may not be the same mod.
jq -rs 'map(select(.origin == "addon")) | unique_by(.file) | [.[].ids[]] | group_by(.) | map(select(length > 1) | .[0])[]' \
  "${server_set}" "${client_set}" >"${rows}"
while IFS= read -r id; do
  refuse "C4 two addons provide the mod id ${id}"
done <"${rows}"

check_set() {
  local label="$1" set_file="$2" other_side="$3"
  # C2: a file name the pack already has.
  jq -rs 'map(select(.origin == "pack")) as $pack | .[] | select(.origin == "addon") |
    . as $addon | ($pack[] | select(.file == $addon.file)) |
    [$addon.name, $addon.file, (.sha256 == $addon.sha256 | tostring)] | @tsv' "${set_file}" >"${rows}"
  while IFS=$'\t' read -r name file same; do
    if [[ "${same}" == true ]]; then
      refuse "C2 addon \"${name}\": the pack already has ${file} (${label} set); remove the addon"
    else
      refuse "C2 addon \"${name}\": the pack has other bytes under ${file} (${label} set)"
    fi
  done <"${rows}"
  # C4: a top-level mod id the pack already has refuses; a nested one warns.
  jq -rs "${VERSIONS}"'
    map(select(.origin == "pack")) as $pack | .[] | select(.origin == "addon") | . as $a |
    $pack[] | . as $p | common($a.ids; $p.ids) as $top |
    (($top[] | ["refuse", $a.name, ., $p.file]),
     ((common($a.ids + $a.nested_ids; $p.ids + $p.nested_ids) - $top)[] | ["warn", $a.name, ., $p.file])) | @tsv
  ' "${set_file}" | sort -u >"${rows}"
  while IFS=$'\t' read -r kind name id pack_file; do
    if [[ "${kind}" == refuse ]]; then
      refuse "C4 addon \"${name}\": the pack already has mod ${id} (${pack_file}, ${label} set)"
    else
      warn "C4 addon \"${name}\": mod ${id} is also nested in ${pack_file} (${label} set); the loader keeps one"
    fi
  done <"${rows}"
  # C6 and C8: every required dependency must be in this set.
  jq -rs --argjson builtin "${BUILTIN_IDS}" --slurpfile other "${workspace}/${other_side}-only.jsonl" '
    ([.[] | .ids[], .nested_ids[]] | unique) as $present | .[] | select(.origin == "addon") |
    . as $addon | ((.depends // []) - $builtin - $present)[] | . as $missing |
    [$addon.name, $addon.file, ., ([$other[] | select((.ids + .nested_ids) | index($missing)) | .name][0] // "")] | @tsv
  ' "${set_file}" >"${rows}"
  while IFS=$'\t' read -r name file dependency elsewhere; do
    if [[ -n "${elsewhere}" ]]; then
      refuse "C8 addon \"${name}\" needs ${dependency} on the ${label} side, but addon \"${elsewhere}\" is ${other_side}-only"
    else
      refuse "C6 addon \"${name}\" (${file}) needs ${dependency}, which the ${label} set does not have"
    fi
  done <"${rows}"
  # C7: a declared breaks that matches a mod in this set, either way round.
  jq -rs "${VERSIONS}"'
    (map(select(.origin == "addon") | .ids[])) as $addon_ids |
    . as $set | .[] | . as $breaker | (.breaks // [])[] | . as $rule |
    select($breaker.origin == "addon" or ($addon_ids | index($rule.id))) |
    $set[] | select(.ids | index($rule.id)) | . as $target |
    ($rule.range | range_matches($rule.syntax; $target.version)) as $verdict |
    select($verdict != false) |
    [($verdict | tostring), "addon \"\(if $breaker.origin == "addon" then $breaker.name else $target.name end)\"",
      $breaker.file, $rule.id, ($target.version // "unknown")] | @tsv
  ' "${set_file}" >"${rows}"
  while IFS=$'\t' read -r verdict name breaker broken version; do
    if [[ "${verdict}" == true ]]; then
      refuse "C7 ${name}: ${breaker} declares it breaks ${broken} ${version} (${label} set)"
    else
      refuse "C7 ${name}: ${breaker} declares breaks for ${broken}, and version ${version} cannot be compared (${label} set)"
    fi
  done <"${rows}"
}

jq -c 'select(.origin == "addon" and .side == "server")' "${server_set}" >"${workspace}/server-only.jsonl"
jq -c 'select(.origin == "addon" and .side == "client")' "${client_set}" >"${workspace}/client-only.jsonl"
check_set server "${server_set}" client
check_set client "${client_set}" server

# C5: an addon the pack author shipped and switched off. Only the file name of
# a disabled JAR is known, so it is matched by name and by mod id prefix.
if [[ -f "${pack_dir}/disabled-mods.txt" ]]; then
  jq -rs 'map(select(.origin == "addon")) | unique_by(.file)[] | [.name, .file, (.ids | join(" "))] | @tsv' \
    "${server_set}" "${client_set}" >"${rows}"
  while IFS=$'\t' read -r name file ids; do
    while IFS= read -r disabled; do
      [[ -n "${disabled}" ]] || continue
      stem="${disabled%.jar.disabled}"
      matched=false
      [[ "${stem}.jar" != "${file}" ]] || matched=true
      for id in ${ids}; do
        if [[ "${stem,,}" == "${id}" || "${stem,,}" == "${id}"-* || "${stem,,}" == "${id}"_* ]]; then
          matched=true
        fi
      done
      [[ "${matched}" == false ]] || warn "C5 addon \"${name}\" matches ${disabled}, which the pack author disabled"
    done <"${pack_dir}/disabled-mods.txt"
  done <"${rows}"
fi

# config.replaces: every pack file the tree overwrites is named, and every name
# overwrites a pack file. Top-level roots reach both sides; client/ only players.
server_paths="${workspace}/server-paths"
client_paths="${workspace}/client-paths"
tree_paths="${workspace}/tree-paths"
replaces="${workspace}/replaces"
: >"${server_paths}"
: >"${tree_paths}"
if [[ -d "${pack_dir}/overrides" ]]; then
  (cd "${pack_dir}/overrides" && find . -type f -printf '%P\n') | LC_ALL=C sort >"${server_paths}"
fi
unzip -Z1 "${pack_dir}/client.zip" | awk -v prefix="${client_overrides}/" \
  'index($0, prefix) == 1 && substr($0, length($0)) != "/" { print substr($0, length(prefix) + 1) }' |
  LC_ALL=C sort >"${client_paths}"
if [[ -d "${addons_dir}/config" ]]; then
  (cd "${addons_dir}/config" && find . -type f -printf '%P\n') | LC_ALL=C sort >"${tree_paths}"
fi
jq -r '(.config.replaces // [])[]' "${lock}" >"${replaces}"
in_list() {
  grep -Fxq -- "$1" "$2"
}
while IFS= read -r path; do
  if [[ "${path}" == client/* ]]; then
    target="${path#client/}"
    in_list "${target}" "${client_paths}" || continue
  elif ! in_list "${path}" "${server_paths}" && ! in_list "${path}" "${client_paths}"; then
    continue
  fi
  in_list "${path}" "${replaces}" ||
    refuse "config: the addons tree overwrites pack file ${path}; name it in config.replaces"
done <"${tree_paths}"
while IFS= read -r path; do
  if ! in_list "${path}" "${tree_paths}"; then
    refuse "config: config.replaces names ${path}, which the addons tree does not have"
  elif [[ "${path}" == client/* ]]; then
    in_list "${path#client/}" "${client_paths}" ||
      refuse "config: config.replaces names ${path}, which the client pack does not have"
  elif ! in_list "${path}" "${server_paths}" && ! in_list "${path}" "${client_paths}"; then
    refuse "config: config.replaces names ${path}, which the pack does not have"
  fi
done <"${replaces}"

if [[ -s "${failures}" ]]; then
  die "$(wc -l <"${failures}" | tr -d ' ') addon check(s) failed"
fi

# mod_index: the mod ids of every file the release records, by digest. Descriptive only.
jq -c 'select(.origin == "addon" and .side == "client")' "${client_set}" >"${workspace}/client-addons.jsonl"
jq -s 'unique_by(.sha256) | map({key: .sha256, value: .ids}) | from_entries' \
  "${server_set}" "${workspace}/client-addons.jsonl" >"${addons_dir}/mod-index.json"

printf 'result=checked\n'
printf 'server_jars=%s\n' "$(wc -l <"${server_set}" | tr -d ' ')"
printf 'client_jars=%s\n' "$(wc -l <"${client_set}" | tr -d ' ')"
printf 'warnings=%s\n' "${warnings}"
