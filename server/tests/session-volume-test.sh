#!/usr/bin/env bash

# The session volume (ADR-0102) on the host: found by its id, formatted only
# when it holds no filesystem, refused when it holds someone else's, mounted at
# the world's directory, and unmounted without an error when already gone. The
# block-device tools are fakes that keep their state in files.

set -Eeuo pipefail

REPOSITORY_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPTS="${REPOSITORY_ROOT}/server/scripts"
fixture="$(mktemp -d /tmp/spawnpoint-session-volume.XXXXXXXX)"
trap 'rm -rf -- "${fixture}"' EXIT

mkdir -p -- "${fixture}/bin" "${fixture}/dev/by-id" "${fixture}/state" "${fixture}/worlds"
: >"${fixture}/dev/nvme1n1"
ln -s -- "${fixture}/dev/nvme1n1" "${fixture}/dev/by-id/nvme-Amazon_Elastic_Block_Store_vol0123456789abcdef0"

# State: state/fs (filesystem type), state/label, state/mounted (target).
cat >"${fixture}/bin/findmnt" <<'FAKE'
#!/usr/bin/env bash
state="${FAKE_STATE}"
case " $* " in
  *" SOURCE / "*) printf '/dev/root\n' ;;
  *" --source "*) [[ -s "${state}/mounted" ]] && cat "${state}/mounted" || exit 1 ;;
  *" --mountpoint "*) [[ -s "${state}/mounted" && "$(cat "${state}/mounted")" == "${@: -1}" ]] || exit 1 ;;
esac
FAKE
cat >"${fixture}/bin/lsblk" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
cat >"${fixture}/bin/blkid" <<'FAKE'
#!/usr/bin/env bash
case " $* " in
  *" TYPE "*) cat "${FAKE_STATE}/fs" 2>/dev/null ;;
  *" LABEL "*) cat "${FAKE_STATE}/label" 2>/dev/null ;;
esac
exit 0
FAKE
cat >"${fixture}/bin/mkfs.xfs" <<'FAKE'
#!/usr/bin/env bash
printf 'xfs\n' >"${FAKE_STATE}/fs"
printf '%s\n' "$3" >"${FAKE_STATE}/label"
printf 'mkfs %s\n' "$*" >>"${FAKE_STATE}/calls"
FAKE
cat >"${fixture}/bin/mount" <<'FAKE'
#!/usr/bin/env bash
printf '%s\n' "${@: -1}" >"${FAKE_STATE}/mounted"
printf 'mount %s\n' "$*" >>"${FAKE_STATE}/calls"
FAKE
cat >"${fixture}/bin/umount" <<'FAKE'
#!/usr/bin/env bash
: >"${FAKE_STATE}/mounted"
printf 'umount %s\n' "$*" >>"${FAKE_STATE}/calls"
FAKE
cat >"${fixture}/bin/sync" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
chmod +x "${fixture}"/bin/*

export PATH="${fixture}/bin:${PATH}"
export FAKE_STATE="${fixture}/state"
export SPAWNPOINT_DEVICE_DIRECTORY="${fixture}/dev/by-id"
export SPAWNPOINT_DEVICE_WAIT_SECONDS=0
export SPAWNPOINT_WORLDS_DIRECTORY="${fixture}/worlds"
mount_volume="${SCRIPTS}/mount-session-volume.sh"
unmount_volume="${SCRIPTS}/unmount-session-volume.sh"
worlds="$(cd -- "${fixture}/worlds" && pwd -P)"

# Malformed arguments are refused before any device is touched.
for args in "world" "World vol-0123456789abcdef0" "world vol-XYZ" "world /dev/nvme1n1"; do
  status=0
  # shellcheck disable=SC2086 # the cases are word lists on purpose
  "${mount_volume}" ${args} >/dev/null 2>&1 || status=$?
  [[ "${status}" == 2 ]] || { printf 'accepted: %s\n' "${args}" >&2; exit 1; }
done
[[ ! -e "${FAKE_STATE}/calls" ]]

# A volume that is not attached fails without formatting anything.
if "${mount_volume}" world vol-00000000000000000 >/dev/null 2>&1; then exit 1; fi
[[ ! -e "${FAKE_STATE}/calls" ]]

# A new volume is formatted, then mounted at the world's directory.
output="$("${mount_volume}" world vol-0123456789abcdef0)"
grep -qx 'session_volume=vol-0123456789abcdef0' <<<"${output}"
grep -qx "mount=${worlds}/world" <<<"${output}"
grep -qx 'formatted=true' <<<"${output}"
grep -q '^mkfs -q -L spsession ' "${FAKE_STATE}/calls"
[[ "$(cat "${FAKE_STATE}/mounted")" == "${worlds}/world" ]]

# Mounting again is a no-op that reports the same mount.
output="$("${mount_volume}" world vol-0123456789abcdef0)"
grep -qx 'formatted=false' <<<"${output}"
[[ "$(grep -c '^mkfs' "${FAKE_STATE}/calls")" == 1 ]]

# Unmount, then unmount again: the second finds nothing and is not an error.
output="$("${unmount_volume}" world)"
grep -qx 'unmounted=true' <<<"${output}"
output="$("${unmount_volume}" world)"
grep -qx 'unmounted=false' <<<"${output}"

# Attached again after an interruption: the filesystem stays, nothing is formatted.
output="$("${mount_volume}" world vol-0123456789abcdef0)"
grep -qx 'formatted=false' <<<"${output}"
[[ "$(grep -c '^mkfs' "${FAKE_STATE}/calls")" == 1 ]]
"${unmount_volume}" world >/dev/null

# A filesystem that is not a session volume is never mounted or formatted.
printf 'ext4\n' >"${FAKE_STATE}/fs"
printf 'data\n' >"${FAKE_STATE}/label"
if "${mount_volume}" world vol-0123456789abcdef0 >/dev/null 2>&1; then exit 1; fi
[[ "$(grep -c '^mkfs' "${FAKE_STATE}/calls")" == 1 ]]
[[ ! -s "${FAKE_STATE}/mounted" ]]

printf 'session volume tests passed\n'
