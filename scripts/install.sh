#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/harness/agent"
DEST="${OMP_AGENT_DIR:-$HOME/.omp/agent}"
SHARE="${OMP_HARNESS_SHARE_DIR:-$HOME/.local/share/omp-harness}"
BACKUP="$DEST.backup.$(date +%Y%m%d-%H%M%S)"

mkdir -p "$DEST" "$SHARE"

backup_if_exists() {
  local rel="$1"
  if [ -e "$DEST/$rel" ]; then
    mkdir -p "$BACKUP/$(dirname "$rel")"
    cp -R "$DEST/$rel" "$BACKUP/$rel"
  fi
}

copy_dir_replace() {
  local rel="$1"
  backup_if_exists "$rel"
  mkdir -p "$DEST/$(dirname "$rel")"
  rm -rf "$DEST/$rel"
  cp -R "$SRC/$rel" "$DEST/$rel"
}

copy_file_replace() {
  local rel="$1"
  backup_if_exists "$rel"
  mkdir -p "$DEST/$(dirname "$rel")"
  cp "$SRC/$rel" "$DEST/$rel"
}

copy_file_if_absent() {
  local src_file="$1"
  local dest_file="$2"
  if [ ! -e "$dest_file" ]; then
    mkdir -p "$(dirname "$dest_file")"
    cp "$src_file" "$dest_file"
  fi
}

copy_file_replace "config.yml"
copy_dir_replace "extensions"
copy_dir_replace "agents"
copy_dir_replace "skills"
copy_dir_replace "mcp-wrappers"

copy_file_if_absent "$SRC/models.yml.example" "$DEST/models.yml"
if [ ! -e "$DEST/mcp.json" ]; then
  sed "s#<HOME>#$HOME#g" "$SRC/mcp.json.example" > "$DEST/mcp.json"
fi

mkdir -p "$DEST/consensus-evolve"
cp "$SRC/consensus-evolve/config.example.json" "$DEST/consensus-evolve/config.example.json"
copy_file_if_absent "$SRC/consensus-evolve/config.example.json" "$DEST/consensus-evolve/config.json"

rm -rf "$SHARE/mcp-llamaswap"
cp -R "$ROOT/mcp-servers/llamaswap" "$SHARE/mcp-llamaswap"
if [ "${OMP_HARNESS_SKIP_NPM:-0}" != "1" ]; then
  if command -v npm >/dev/null 2>&1; then
    (cd "$SHARE/mcp-llamaswap" && npm install --omit=dev)
  else
    printf 'npm not found; install MCP server dependencies manually in %s\n' "$SHARE/mcp-llamaswap" >&2
  fi
fi

printf 'Installed OMP harness files into %s\n' "$DEST"
printf 'Installed bundled MCP servers into %s\n' "$SHARE"
printf 'Backups, if any, are under %s\n' "$BACKUP"
printf 'Review models.yml, mcp.json, and consensus-evolve/config.json before use.\n'
