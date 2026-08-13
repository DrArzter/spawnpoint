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
# AL2023 includes curl-minimal, which provides the curl binary and conflicts
# with the full `curl` package. Do not request the latter here.
dnf install -y docker git jq rsync tar zstd xfsprogs

log "enabling Docker"
systemctl enable --now docker
usermod -aG docker ec2-user

# Amazon Linux's Docker package does not include the Compose CLI plugin.
# Install one exact upstream binary and verify its published digest.
readonly COMPOSE_VERSION="v5.1.4"
readonly COMPOSE_SHA256="33b208d7e76639db742fae84b966cc01dacae58ca3fc4dabbc907045aefdf0c4"
readonly COMPOSE_TARGET="/usr/local/lib/docker/cli-plugins/docker-compose"

if [[ ! -x ${COMPOSE_TARGET} ]]; then
  log "installing Docker Compose ${COMPOSE_VERSION}"
  install -d -m 0755 "$(dirname "${COMPOSE_TARGET}")"
  compose_download="$(mktemp /tmp/docker-compose.XXXXXX)"
  trap 'rm -f -- "${compose_download:-}"' EXIT
  curl --fail --silent --show-error --location \
    "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-linux-x86_64" \
    -o "${compose_download}"
  printf '%s  %s\n' "${COMPOSE_SHA256}" "${compose_download}" | sha256sum --check
  install -m 0755 "${compose_download}" "${COMPOSE_TARGET}"
  rm -f -- "${compose_download}"
  trap - EXIT
fi

docker compose version

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
