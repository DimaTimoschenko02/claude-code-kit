#!/usr/bin/env bash
# cc-learning-log uninstaller. Removes ONLY what the installer added (hook entries
# tagged _cc_ll, the scripts, the skill, the version stamp). User data
# (learning-log/, config, state) is kept unless --purge.
#
# Usage:
#   ./uninstall.sh [target] [--purge]
set -euo pipefail

PURGE=0; TARGET=""
for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    *) TARGET="$a" ;;
  esac
done
TARGET="$(cd "${TARGET:-$PWD}" 2>/dev/null && pwd)" || { echo "target dir not found" >&2; exit 1; }
CLAUDE_DIR="$TARGET/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"

# --- Strip our tagged hook entries from settings.json ---
if command -v jq >/dev/null 2>&1 && [ -f "$SETTINGS" ]; then
  if ! jq empty "$SETTINGS" 2>/dev/null; then
    echo "WARN: $SETTINGS is invalid JSON — left untouched; remove our hooks manually." >&2
  else
    # Warn about untagged copies of our hooks (e.g. hand-added) — we won't remove those.
    if jq -e '[.hooks[]?[]? | select((._cc_ll // false) != true) | .hooks[]? | select((.command // "") | test("learning-log-trigger|skill-invocation-log"))] | length > 0' "$SETTINGS" >/dev/null 2>&1; then
      echo "NOTE: found untagged learning-log hook entries (not added by this installer) — leaving them in place." >&2
    fi
    tmp="$(mktemp "$CLAUDE_DIR/.settings.XXXXXX")"
    if jq '
      def isours: ((._cc_ll // false) == true) or (any((.hooks // [])[]?; (._cc_ll // false) == true));
      .hooks |= ( (. // {}) | to_entries
        | map( .value |= map(select(isours | not)) )
        | map(select(.value | length > 0))
        | from_entries )
    ' "$SETTINGS" > "$tmp" && jq empty "$tmp" 2>/dev/null; then
      mv "$tmp" "$SETTINGS"; echo "removed cc-learning-log hook entries from settings.json" >&2
    else
      rm -f "$tmp"; echo "WARN: could not rewrite settings.json — left untouched." >&2
    fi
  fi
fi

# --- Remove our files ---
rm -f "$CLAUDE_DIR/hooks/learning-log-trigger.sh" \
      "$CLAUDE_DIR/hooks/learning-log-analyze.sh" \
      "$CLAUDE_DIR/hooks/skill-invocation-log.sh" \
      "$CLAUDE_DIR/hooks/_lib/env.sh" \
      "$CLAUDE_DIR/hooks/_lib/paths.sh" \
      "$CLAUDE_DIR/hooks/_lib/config.sh" \
      "$CLAUDE_DIR/skills/learning-log/SKILL.md" \
      "$CLAUDE_DIR/.cc-learning-log.version"
rm -f "$CLAUDE_DIR/skills/learning-log/"SKILL.md.bak.* 2>/dev/null || true
# Drop now-empty managed dirs (rmdir is a no-op if the user has other files there).
rmdir "$CLAUDE_DIR/skills/learning-log" 2>/dev/null || true
rmdir "$CLAUDE_DIR/hooks/_lib" 2>/dev/null || true
rmdir "$CLAUDE_DIR/hooks" 2>/dev/null || true
echo "removed cc-learning-log scripts + skill" >&2

# --- User data ---
if [ "$PURGE" = 1 ]; then
  rm -rf "$CLAUDE_DIR/learning-log" "$CLAUDE_DIR/state" "$CLAUDE_DIR/learning-log.config.json"
  # Drop the .gitignore block.
  GI="$TARGET/.gitignore"
  if [ -f "$GI" ]; then
    tmpgi="$(mktemp "$TARGET/.gi.XXXXXX")"
    awk 'BEGIN{skip=0} /# >>> cc-learning-log >>>/{skip=1} skip==0{print} /# <<< cc-learning-log <<</{skip=0}' "$GI" > "$tmpgi" && mv "$tmpgi" "$GI"
  fi
  echo "--purge: removed learning-log/, state/, config, and .gitignore block" >&2
else
  echo "kept learning-log/, state/, and config (use --purge to remove)" >&2
fi
