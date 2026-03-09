#!/bin/bash
set -euo pipefail

INSTALL_DIR="$HOME/.iteris"
BIN_LINK="/usr/local/bin/iteris"
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
  INSTALL_CMD="npm install"
  BUILD_CMD="npm run build"
  warn "pnpm not found — falling back to npm (pnpm is recommended)."
fi

# claude (soft warning)
if ! command -v claude >/dev/null 2>&1; then
  warn "Claude Code CLI not found. You'll need it to run Iteris."
  warn "Install: npm install -g @anthropic-ai/claude-code"
fi

# ------------------------------------------------------------------
# Clone or update
# ------------------------------------------------------------------
if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Updating existing installation..."
  git -C "$INSTALL_DIR" pull --ff-only
else
  info "Cloning Iteris into $INSTALL_DIR..."
  git clone "$REPO_URL" "$INSTALL_DIR"
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
ok "Iteris installed successfully!"
echo ""
info "Before running, make sure you have:"
info "  1. Set GITHUB_TOKEN as an environment variable"
info "  2. Installed and authenticated Claude Code (claude)"
echo ""
info "Usage:"
info "  cd your-repo && iteris"
echo ""
