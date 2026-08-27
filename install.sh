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

wecom_cli_supported() {
  local output="$1"
  [[ "$output" =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]] || return 1
  local major="${BASH_REMATCH[1]}"
  local minor="${BASH_REMATCH[2]}"
  (( 10#$major > 1 || (10#$major == 1 && 10#$minor >= 2) ))
}

ensure_wecom_cli() {
  local installed=""
  if command -v wecom-cli >/dev/null 2>&1; then
    installed="$(wecom-cli --version 2>/dev/null || true)"
    if wecom_cli_supported "$installed"; then
      printf 'Found %s.\n' "$installed"
      return
    fi
    printf 'Updating official wecom-cli to 1.2.0+; current version is %s.\n' "${installed:-unknown}"
  else
    printf 'Installing official wecom-cli 1.2.0+...\n'
  fi

  if ! run npm install --global @wecom/cli@1.2.0; then
    printf 'Could not install official wecom-cli. Check network access and npm global permissions, then run: npm install --global @wecom/cli@1.2.0\n' >&2
    exit 1
  fi
  if [[ "$DRY_RUN" == "1" ]]; then return; fi
  if ! command -v wecom-cli >/dev/null 2>&1; then
    printf 'wecom-cli was installed, but the npm global bin directory is not in PATH. Add it to PATH, then rerun this installer.\n' >&2
    exit 1
  fi
  installed="$(wecom-cli --version 2>/dev/null || true)"
  if ! wecom_cli_supported "$installed"; then
    printf 'wecom-cli 1.2.0+ is required; installed version is %s. Reinstall it with: npm install --global @wecom/cli@1.2.0\n' "${installed:-unknown}" >&2
    exit 1
  fi
}

wecom_cli_authorized() {
  [[ "$(wecom-cli auth show --status 2>/dev/null || true)" == "authorized" ]]
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
NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])" 2>/dev/null || true)"
if [[ ! "$NODE_MAJOR" =~ ^[0-9]+$ ]] || (( NODE_MAJOR < 22 )); then
  printf 'Node.js 22+ is required; current version is %s.\n' "$(node --version)" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  printf 'npm was not found in PATH. Reinstall Node.js 22+ with npm.\n' >&2
  exit 1
fi

ensure_wecom_cli

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
  if wecom_cli_authorized; then
    printf 'wecom-cli is already configured. Next: threadferry onboard; it will ask whether to reuse the saved credentials.\n'
  else
    printf 'Next: wecom-cli auth init, then threadferry onboard\n'
  fi
  exit 0
fi

if ! wecom_cli_authorized; then
  printf 'Initializing official wecom-cli (scan QR code or enter Bot ID and Secret)...\n'
  if [[ -t 0 && -t 1 ]]; then
    if ! wecom-cli auth init; then
      printf 'wecom-cli initialization failed. Retry with: wecom-cli auth init\n' >&2
      exit 1
    fi
  elif [[ -t 1 && -r /dev/tty && -w /dev/tty ]]; then
    if ! wecom-cli auth init </dev/tty >/dev/tty 2>/dev/tty; then
      printf 'wecom-cli initialization failed. Retry with: wecom-cli auth init\n' >&2
      exit 1
    fi
  else
    printf 'No interactive terminal detected. Next: wecom-cli auth init, then threadferry onboard\n'
    exit 0
  fi
  if ! wecom_cli_authorized; then
    printf 'wecom-cli initialization did not produce a valid authorization. Retry with: wecom-cli auth init\n' >&2
    exit 1
  fi
fi

printf 'wecom-cli is configured. ThreadFerry will ask whether to reuse its saved credentials.\n'

if [[ -t 0 && -t 1 ]]; then
  exec threadferry onboard
elif [[ -t 1 && -r /dev/tty && -w /dev/tty ]]; then
  exec threadferry onboard </dev/tty >/dev/tty 2>/dev/tty
else
  printf 'No interactive terminal detected. Next: threadferry onboard\n'
fi
