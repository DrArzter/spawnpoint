#!/usr/bin/env bash

# Holder first (ADR-0080): an operator script that writes a world record or a
# release pointer calls hold_release before the write and stops when it fails.
# Source this file; it needs REPOSITORY_ROOT. AWS_PROFILE and AWS_REGION reach
# the tool through the environment.

# usage: hold_release <game> <preset> <release> <world> <generation> <role[,role...]>
hold_release() {
  command -v node >/dev/null 2>&1 || {
    printf 'error: node is required to write the release holder (install Node.js 22.18 or later)\n' >&2
    return 1
  }
  node "${REPOSITORY_ROOT}/lambdas/tools/hold-release.ts" "$@" >&2 || {
    printf 'error: the release holder was not written; nothing was changed (run "npm ci" in lambdas/ if modules are missing)\n' >&2
    return 1
  }
}
