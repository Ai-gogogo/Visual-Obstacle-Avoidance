#!/bin/bash
set -eu
here="$(cd "$(dirname "$0")" && pwd -P)"
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
settings="$here/../../.visionassist/macos.env"
if [[ -f "$settings" ]]; then
  set -a
  source "$settings"
  set +a
fi
exec /usr/bin/python3 "$here/launcher.py" "$@"
