#!/usr/bin/env bash
# chat-audit uninstaller — removes the skill, the hook and its settings entry.
# Keeps your config and ledger unless --purge is passed.
#
# Usage:
#   ./uninstall.sh [target] [--purge]
set -euo pipefail

PURGE=0
ARGS=()
for a in "$@"; do
  if [ "$a" = "--purge" ]; then PURGE=1; else ARGS+=("$a"); fi
done
TARGET="$(cd "${ARGS[0]:-$PWD}" 2>/dev/null && pwd)" || { echo "target dir not found" >&2; exit 1; }
CLAUDE_DIR="$TARGET/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"

rm -rf "$CLAUDE_DIR/skills/chat-audit"
rm -f  "$CLAUDE_DIR/hooks/chat-audit-nudge.sh" "$CLAUDE_DIR/.chat-audit.version"

if [ "$PURGE" = 1 ]; then
  rm -f  "$CLAUDE_DIR/chat-audit.config.json"
  rm -rf "$CLAUDE_DIR/state/chat-audit"
  echo "purged config and ledger" >&2
else
  echo "kept chat-audit.config.json and state/chat-audit/ (pass --purge to remove)" >&2
fi

if command -v jq >/dev/null 2>&1 && [ -f "$SETTINGS" ]; then
  tmp="$(mktemp "$CLAUDE_DIR/.settings.XXXXXX")"
  if jq '
    .hooks.UserPromptSubmit = [ (.hooks.UserPromptSubmit // [])[]
      | .hooks = [ (.hooks // [])[] | select((.command // "") | test("chat-audit-nudge.sh") | not) ]
      | select((.hooks | length) > 0) ]
    | if (.hooks.UserPromptSubmit | length) == 0 then del(.hooks.UserPromptSubmit) else . end
  ' "$SETTINGS" > "$tmp" && jq empty "$tmp" 2>/dev/null; then
    mv "$tmp" "$SETTINGS"
  else
    rm -f "$tmp"; echo "WARN: could not clean settings.json — remove the chat-audit-nudge.sh entry by hand" >&2
  fi
else
  echo "NOTE: remove the chat-audit-nudge.sh hook entry from $SETTINGS by hand" >&2
fi

echo "chat-audit removed from $CLAUDE_DIR" >&2
