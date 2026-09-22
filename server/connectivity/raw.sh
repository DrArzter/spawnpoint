#!/usr/bin/env bash

# shellcheck disable=SC2034 # Functions return the host through CONNECTIVITY_HOST to their sourcer.

connectivity_prepare() {
  CONNECTIVITY_HOST="$("${SCRIPT_DIR}/read-public-address.sh")" || {
    printf 'error: this host has no public address to publish\n' >&2
    return 1
  }
}

connectivity_publish() { :; }
connectivity_retract() { :; }
