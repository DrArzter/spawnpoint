#!/usr/bin/env bash

set -Eeuo pipefail

cat >&2 <<'EOF'
error: direct release promotion is disabled after the Lifecycle V2 cutover.
The legacy promotion workflow composes V1 host operations and would bypass the
fenced session record. Migrate promotion to the V2 session contract before
re-enabling this entry point.
EOF
exit 2
