#!/usr/bin/env bash
set -euo pipefail

RELEASE_PACKAGE_URL="https://github.com/GnaixEuy/threadferry/releases/latest/download/threadferry.tgz"
NO_ONBOARD=0
DRY_RUN=0

usage() {
  cat <<'EOF'
ThreadFerry installer

Usage:
  bash install.sh [--no-onboard] [--dry-run]

Options:
  --no-onboard  Install only; do not open the setup wizard
  --dry-run     Print commands without changing the machine
  -h, --help    Show this help
EOF
}

run() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '  '
    printf '%q ' "$@"
    printf '\n'
  else
    "$@"
  fi
}

for argument in "$@"; do
  case "$argument" in
    --no-onboard) NO_ONBOARD=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'ThreadFerry installer: unknown option: %s\n' "$argument" >&2; usage >&2; exit 2 ;;
  esac
done

case "$(uname -s)" in
  Darwin|Linux) ;;
  *) printf 'ThreadFerry currently supports macOS and Linux.\n' >&2; exit 1 ;;
esac

if ! command -v node >/dev/null 2>&1; then
  printf 'Node.js 22+ is required: https://nodejs.org/en/download\n' >&2
  exit 1
fi
if [[ "$(node -p "Number(process.versions.node.split('.')[0])")" -lt 22 ]]; then
  printf 'Node.js 22+ is required; current version is %s.\n' "$(node --version)" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  printf 'npm was not found in PATH. Reinstall Node.js 22+ with npm.\n' >&2
  exit 1
fi

printf 'Installing ThreadFerry...\n'
GLOBAL_PACKAGE_PATH="$(npm root --global)/threadferry"
GLOBAL_BIN_PATH="$(npm prefix --global)/bin/threadferry"
if [[ -L "$GLOBAL_PACKAGE_PATH" ]]; then
  printf 'Replacing linked ThreadFerry development install...\n'
  if [[ -L "$GLOBAL_BIN_PATH" && "$(readlink "$GLOBAL_BIN_PATH")" == *"node_modules/threadferry/"* ]]; then
    run unlink "$GLOBAL_BIN_PATH"
  fi
  run unlink "$GLOBAL_PACKAGE_PATH"
fi

run npm install --global --ignore-scripts "$RELEASE_PACKAGE_URL"

if [[ "$DRY_RUN" == "1" ]]; then
  printf 'Dry run complete. Next: threadferry onboard\n'
  exit 0
fi
if ! command -v threadferry >/dev/null 2>&1; then
  printf 'ThreadFerry was installed, but its npm global bin directory is not in PATH.\n' >&2
  printf 'Add the npm global bin directory to PATH, then run: threadferry onboard\n' >&2
  exit 1
fi

printf 'Installed ThreadFerry %s.\n' "$(threadferry --version)"
if [[ "$NO_ONBOARD" == "1" ]]; then
  printf 'Next: threadferry onboard\n'
elif [[ -t 0 && -t 1 ]]; then
  exec threadferry onboard
elif [[ -t 1 && -r /dev/tty && -w /dev/tty ]]; then
  exec threadferry onboard </dev/tty >/dev/tty 2>/dev/tty
else
  printf 'No interactive terminal detected. Next: threadferry onboard\n'
fi
