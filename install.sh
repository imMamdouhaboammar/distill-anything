#!/usr/bin/env bash
# install.sh — Universal multi-agent installer for codebase-constitution
# Copyright (c) 2026 Mamdouh Aboammar. MIT License.
# https://github.com/imMamdouhaboammar/codebase-constitution

set -euo pipefail

SKILL_NAME="codebase-constitution"
REPO="imMamdouhaboammar/codebase-constitution"
VERSION="${1:-latest}"

echo ""
echo "  ◈ codebase-constitution — Universal Installer"
echo "  ─────────────────────────────────────────────"
echo "  © 2026 Mamdouh Aboammar · MIT License"
echo ""

# Use npx to install (handles downloading and local skill installation)
if command -v npx &>/dev/null; then
  echo "  Installing via npx..."
  npx "codebase-constitution@${VERSION}" install
  echo ""
  echo "  ✓ Installed for all detected agent hosts."
  echo ""
  echo "  Activate with:"
  echo "    \"reverse-engineer this codebase into a constitution\""
  echo ""
else
  echo "  ✗ npx not found. Install Node.js 18+ then run:"
  echo "    npx codebase-constitution install"
  echo ""
  exit 1
fi
