#!/usr/bin/env bash
#
# install-cli.sh — put `agent-studio-memory` on your PATH.
#
# Symlinks bin/agent-studio-memory into a PATH directory so agents can write
# continuity-scored memory from any shell. Builds the release binary first if it
# is missing (the wrapper prefers it). Override the target dir with PREFIX=...
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WRAPPER="$REPO_ROOT/bin/agent-studio-memory"

chmod +x "$WRAPPER"

# The wrapper prefers the release binary; build it once if absent.
if [[ ! -x "$REPO_ROOT/src-tauri/target/release/app" ]]; then
  echo "No release binary found — building it once (this can take a few minutes)..."
  ( cd "$REPO_ROOT/src-tauri" && cargo build --release --bin app )
fi

BIN_DIR="${PREFIX:-$HOME/.local/bin}"
mkdir -p "$BIN_DIR"
ln -sf "$WRAPPER" "$BIN_DIR/agent-studio-memory"
echo "Linked: $BIN_DIR/agent-studio-memory -> $WRAPPER"

case ":$PATH:" in
  *":$BIN_DIR:"*) echo "OK: $BIN_DIR is on your PATH." ;;
  *) echo "NOTE: add $BIN_DIR to your PATH:  export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

cat <<'EOF'
Done. Try a write (uses your configured memory root):
  agent-studio-memory add-memory --content "a test note" --agent me --project studio
  agent-studio-memory supersede --old <path|name> --new <name>
EOF
