#!/usr/bin/env bash
# Cross-platform PATH restore for nohup'd forks.
#
# Background hooks forked via `nohup` lose the interactive shell PATH and don't
# see nvm/brew/native-installer binaries (claude, node, jq) -> the classifier
# silently writes 0 entries. This is the single most-forgotten failure mode.
# Source this from any hook BEFORE calling claude/jq:
#
#     SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#     [ -f "$SCRIPT_DIR/_lib/env.sh" ] && . "$SCRIPT_DIR/_lib/env.sh"
#
# Idempotent (dedups), safe to source multiple times.

_ll_prepend() {  # _ll_prepend DIR — prepend DIR to PATH if it exists and isn't already present
  case ":$PATH:" in
    *":$1:"*) : ;;                       # already present
    *) [ -d "$1" ] && PATH="$1:$PATH" ;;
  esac
}

# Native Claude Code installer (curl install -> ~/.local/bin/claude).
_ll_prepend "$HOME/.local/bin"

# nvm — honor custom $NVM_DIR, the default, and the common Docker location.
for _ll_nvm in "${NVM_DIR:-}" "$HOME/.nvm" "/usr/local/nvm"; do
  [ -n "$_ll_nvm" ] && [ -d "$_ll_nvm/versions/node" ] || continue
  _ll_node_bin="$(ls -d "$_ll_nvm"/versions/node/v*/bin 2>/dev/null | sort -V | tail -1)"
  [ -n "$_ll_node_bin" ] && _ll_prepend "$_ll_node_bin"
  break
done

# Other version managers' shims.
_ll_prepend "${VOLTA_HOME:-$HOME/.volta}/bin"
_ll_prepend "${ASDF_DATA_DIR:-$HOME/.asdf}/shims"

# Homebrew (Apple Silicon + Intel) and Linuxbrew.
_ll_prepend "/opt/homebrew/bin"
_ll_prepend "/usr/local/bin"
_ll_prepend "/home/linuxbrew/.linuxbrew/bin"

export PATH
unset _ll_nvm _ll_node_bin
