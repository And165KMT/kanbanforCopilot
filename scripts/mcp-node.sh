#!/usr/bin/env bash
set -euo pipefail

resolve_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi

  local candidate
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  local nvm_dir="${NVM_DIR:-$HOME/.nvm}"
  local versions_dir="$nvm_dir/versions/node"
  if [ -d "$versions_dir" ]; then
    local preferred=""
    if [ -n "${KANBANTO_WORKSPACE:-}" ] && [ -f "${KANBANTO_WORKSPACE}/.nvmrc" ]; then
      preferred="$(tr -d '[:space:]' < "${KANBANTO_WORKSPACE}/.nvmrc" | sed 's/^v//')"
    fi

    if [ -n "$preferred" ] && [ -x "$versions_dir/v$preferred/bin/node" ]; then
      printf '%s\n' "$versions_dir/v$preferred/bin/node"
      return 0
    fi

    local latest
    latest="$(ls -1v "$versions_dir" 2>/dev/null | tail -n 1 || true)"
    if [ -n "$latest" ] && [ -x "$versions_dir/$latest/bin/node" ]; then
      printf '%s\n' "$versions_dir/$latest/bin/node"
      return 0
    fi
  fi

  return 1
}

node_bin="$(resolve_node || true)"
if [ -z "${node_bin:-}" ]; then
  echo "kanbanto-mcp: Node.js executable not found." >&2
  echo "Install Node.js or update .vscode/mcp.json to point at your node binary." >&2
  exit 127
fi

exec "$node_bin" "$@"
