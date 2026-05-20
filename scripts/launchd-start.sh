#!/bin/bash
set -euo pipefail

export PATH="${PATH:-/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"
: "${HOME:?Set HOME before starting nordrelay}"

cd "${NORDRELAY_SOURCE_ROOT:-$HOME/projects/nordrelay}"
exec node plugins/nordrelay/scripts/nordrelay.mjs foreground
