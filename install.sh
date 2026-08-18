#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="git+https://github.com/GnaixEuy/threadferry.git"
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

SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
printf 'Installing ThreadFerry...\n'
if [[ -f "$SCRIPT_DIRECTORY/package.json" && -f "$SCRIPT_DIRECTORY/src/cli.ts" ]]; then
  run npm ci --ignore-scripts --prefix "$SCRIPT_DIRECTORY"
  run npm run build --prefix "$SCRIPT_DIRECTORY"
  run npm install --global --ignore-scripts "$SCRIPT_DIRECTORY"
else
  if ! command -v git >/dev/null 2>&1; then
    printf 'Git is required for remote installation: https://git-scm.com/downloads\n' >&2
    exit 1
  fi
  run npm install --global "$REPOSITORY"
fi

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
