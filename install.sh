#!/bin/bash
set -euo pipefail

RELEASE_VERSION="1.1.0"
INSTALL_DIR="${ITERIS_INSTALL_DIR:-$HOME/.iteris}"
BIN_LINK="${ITERIS_BIN_DIR:-/usr/local/bin}/iteris"
REPO_URL="https://github.com/Oscar-Codes-Life/Iteris.git"
MIN_NODE_VERSION=22

# Colors
BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
RESET='\033[0m'

info()  { echo -e "${BOLD}[iteris]${RESET} $1"; }
ok()    { echo -e "${GREEN}[iteris]${RESET} $1"; }
warn()  { echo -e "${YELLOW}[iteris]${RESET} $1"; }
fail()  { echo -e "${RED}[iteris]${RESET} $1"; exit 1; }

# Each installer selects its own release, never an unversioned branch build.
case "${1:-}" in
  --version)
    [[ $# -eq 2 ]] || fail "Usage: install.sh [--version 1.1.0 | --uninstall]"
    RELEASE_VERSION="${2#v}"
    ;;
  --uninstall) [[ $# -eq 1 ]] || fail "Usage: install.sh --uninstall" ;;
  "") ;;
  *) fail "Unknown option: $1. Use --version <version> or --uninstall." ;;
esac
[[ "$RELEASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Expected a stable version such as 1.1.0."
RELEASE_TAG="v$RELEASE_VERSION"

# ------------------------------------------------------------------
# Uninstall
# ------------------------------------------------------------------
if [[ "${1:-}" == "--uninstall" ]]; then
  info "Uninstalling Iteris..."
  if [[ -L "$BIN_LINK" ]]; then
    rm -f "$BIN_LINK" 2>/dev/null || sudo rm -f "$BIN_LINK"
    ok "Removed symlink $BIN_LINK"
  fi
  if [[ -d "$INSTALL_DIR" ]]; then
    rm -rf "$INSTALL_DIR"
    ok "Removed $INSTALL_DIR"
  fi
  ok "Iteris uninstalled."
  exit 0
fi

# ------------------------------------------------------------------
# Prerequisite checks
# ------------------------------------------------------------------

# git
command -v git >/dev/null 2>&1 || fail "git is required but not installed."

# node
command -v node >/dev/null 2>&1 || fail "Node.js is required but not installed. Install it from https://nodejs.org"
NODE_VERSION=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
if [[ "$NODE_VERSION" -lt "$MIN_NODE_VERSION" ]]; then
  fail "Node.js >= $MIN_NODE_VERSION is required (found v$NODE_VERSION). Update at https://nodejs.org"
fi

# Package manager — prefer pnpm, fall back to npm
if command -v pnpm >/dev/null 2>&1; then
  PKG_MGR="pnpm"
  INSTALL_CMD="pnpm install --frozen-lockfile"
  BUILD_CMD="pnpm run build"
else
  PKG_MGR="npm"
  INSTALL_CMD="npm install --no-package-lock"
  BUILD_CMD="npm run build"
  warn "pnpm not found — falling back to npm (pnpm is recommended)."
fi

# Harness selection happens in the setup wizard.
if ! command -v gh >/dev/null 2>&1; then
  warn "GitHub CLI (gh) is required for authentication and PRs. Install it from https://cli.github.com/"
fi
info "Choose Claude Code or Codex in setup. Install and authenticate your selected harness first."

# ------------------------------------------------------------------
# Clone or update
# ------------------------------------------------------------------
if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Updating installation to $RELEASE_TAG..."
  ORIGIN_URL=$(git -C "$INSTALL_DIR" remote get-url origin)
  [[ "$ORIGIN_URL" == "$REPO_URL" || "$ORIGIN_URL" == "git@github.com:Oscar-Codes-Life/Iteris.git" ]] || fail "Unexpected repository in $INSTALL_DIR; leaving it unchanged."
  if ! git -C "$INSTALL_DIR" diff --quiet || ! git -C "$INSTALL_DIR" diff --cached --quiet; then
    fail "Local changes in $INSTALL_DIR. Commit or save them before updating."
  fi
  git -C "$INSTALL_DIR" fetch --depth 1 origin "refs/tags/$RELEASE_TAG:refs/tags/$RELEASE_TAG"
  git -C "$INSTALL_DIR" checkout --detach "$RELEASE_TAG"
else
  info "Installing $RELEASE_TAG into $INSTALL_DIR..."
  git clone --depth 1 --branch "$RELEASE_TAG" "$REPO_URL" "$INSTALL_DIR"
fi

# ------------------------------------------------------------------
# Install dependencies & build
# ------------------------------------------------------------------
info "Installing dependencies with $PKG_MGR..."
(cd "$INSTALL_DIR" && $INSTALL_CMD)

info "Building..."
(cd "$INSTALL_DIR" && $BUILD_CMD)

# ------------------------------------------------------------------
# Symlink
# ------------------------------------------------------------------
info "Creating symlink at $BIN_LINK..."
[[ ! -e "$BIN_LINK" || -L "$BIN_LINK" ]] || fail "$BIN_LINK already exists and is not a symlink. Choose another ITERIS_BIN_DIR."
if ln -sf "$INSTALL_DIR/dist/index.js" "$BIN_LINK" 2>/dev/null; then
  ok "Symlink created."
else
  warn "Permission denied — retrying with sudo..."
  sudo ln -sf "$INSTALL_DIR/dist/index.js" "$BIN_LINK"
  ok "Symlink created (with sudo)."
fi

# ------------------------------------------------------------------
# Done
# ------------------------------------------------------------------
echo ""
ok "Iteris $RELEASE_TAG installed successfully!"
echo ""
info "Before running, make sure you have:"
info "  1. Install GitHub CLI (gh); setup will guide authentication"
info "  2. Install and authenticate Claude Code or Codex, or configure project-local prerequisites"
echo ""
info "Usage:"
info "  cd your-repo && iteris"
info "  iteris setup   # configure without running tickets"
info "  iteris --version"
echo ""
