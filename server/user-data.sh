#!/usr/bin/env bash
# First-boot bootstrap for the disposable Amazon Linux 2023 host.
#
# Deliberately does not format disks, install ZeroTier, clone the repository or
# start Minecraft. Those steps need an attached volume, an exact Git commit and
# operator-supplied configuration, none of which user-data can safely guess.

set -Eeuo pipefail

readonly LOG_TAG="spawnpoint-user-data"

log() {
  printf '%s %s\n' "${LOG_TAG}:" "$*"
}

if [[ ${EUID} -ne 0 ]]; then
  printf 'error: user-data must run as root\n' >&2
  exit 1
fi

export DNF_YUM_AUTO_YES=1

log "installing host packages"
dnf update -y
dnf install -y docker git jq rsync tar zstd xfsprogs

log "enabling Docker"
systemctl enable --now docker
usermod -aG docker ec2-user

if ! rpm -q amazon-ssm-agent >/dev/null 2>&1; then
  log "SSM Agent is absent; installing the AWS package"
  dnf install -y \
    https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/latest/linux_amd64/amazon-ssm-agent.rpm
fi

log "enabling SSM Agent"
systemctl enable --now amazon-ssm-agent

# The data volume is mounted here by prepare-data-volume.sh after its exact
# device has been identified. Creating only the empty mount point is safe.
install -d -m 0755 /srv/spawnpoint
install -d -m 0755 /opt/spawnpoint

cat >/etc/spawnpoint-host.env <<'EOF'
SPAWNPOINT_DATA_MOUNT=/srv/spawnpoint
SPAWNPOINT_APP_DIRECTORY=/srv/spawnpoint/app
EOF
chmod 0644 /etc/spawnpoint-host.env

cat >/etc/motd.d/spawnpoint <<'EOF'
Spawnpoint M0 host

The base host is ready. The data volume, repository, secrets, ZeroTier and
Minecraft are configured explicitly through SSM; user-data does not guess them.
EOF

log "base host is ready"

