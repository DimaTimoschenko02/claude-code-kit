#!/usr/bin/env bash
# instructions-tuning uninstaller.
#
#   ./uninstall.sh [target]            # remove the gate hook + its settings entry; keep skill, config, logger
#   ./uninstall.sh [target] --purge    # also remove the skill, config, version stamp, .gitignore block,
#                                       # and the shared logger + its PostToolUse entry — but ONLY if
#                                       # cc-learning-log isn't also installed (it shares the logger).
#
# The logger (skill-invocation-log.sh) is shared with cc-learning-log. A plain
# uninstall always leaves it. --purge removes it only when cc-learning-log is
# absent, and only the PostToolUse entry THIS package tagged (_cc_it).
set -euo pipefail

TARGET="$(cd "${1:-$PWD}" 2>/dev/null && pwd)" || { echo "target dir not found: ${1:-$PWD}" >&2; exit 1; }
PURGE=0; [ "${2:-}" = "--purge" ] && PURGE=1
CLAUDE_DIR="$TARGET/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"

command -v jq >/dev/null 2>&1 || { echo "jq required to edit settings.json safely" >&2; exit 1; }

# cc-learning-log also ships the logger — don't strip it out from under that package.
LL_PRESENT=0
[ -f "$CLAUDE_DIR/.cc-learning-log.version" ] && LL_PRESENT=1
DROP_LOGGER=0
[ "$PURGE" = 1 ] && [ "$LL_PRESENT" = 0 ] && DROP_LOGGER=1

# Always: drop the gate hook + any PreToolUse block referencing it.
rm -f "$CLAUDE_DIR/hooks/skill-gate-guard.sh"
if [ -f "$SETTINGS" ] && jq empty "$SETTINGS" 2>/dev/null; then
  tmp="$(mktemp "$CLAUDE_DIR/.settings.XXXXXX")"
  jq --arg drop "$DROP_LOGGER" '
    if .hooks.PreToolUse then
      .hooks.PreToolUse |= [ .[]? | select( all(.hooks[]?; (.command // "") | test("skill-gate-guard.sh") | not) ) ]
    else . end
    | if ($drop == "1") and .hooks.PostToolUse then
        .hooks.PostToolUse |= [ .[]? | select( any(.hooks[]?; (._cc_it == true) and ((.command // "") | test("skill-invocation-log.sh"))) | not ) ]
      else . end
  ' "$SETTINGS" > "$tmp" && jq empty "$tmp" 2>/dev/null \
    && mv "$tmp" "$SETTINGS" || { rm -f "$tmp"; echo "ERROR: settings edit failed; untouched." >&2; exit 1; }
fi

if [ "$PURGE" = 1 ]; then
  rm -rf "$CLAUDE_DIR/skills/instructions-tuning"
  rm -f "$CLAUDE_DIR/skill-gate.config.json" "$CLAUDE_DIR/.instructions-tuning.version"
  if [ "$DROP_LOGGER" = 1 ]; then
    rm -f "$CLAUDE_DIR/hooks/skill-invocation-log.sh" "$CLAUDE_DIR/state/skill-invocations.jsonl"
  else
    echo "kept skill-invocation-log.sh + its hook entry — cc-learning-log is installed and shares it" >&2
  fi
  GI="$TARGET/.gitignore"
  if [ -f "$GI" ]; then
    sed -i.bak '/# >>> instructions-tuning >>>/,/# <<< instructions-tuning <<</d' "$GI" && rm -f "$GI.bak"
  fi
  echo "purged instructions-tuning from $CLAUDE_DIR" >&2
else
  echo "removed skill-gate-guard.sh + its hook entry from $CLAUDE_DIR (skill, config, logger kept). --purge to remove all." >&2
fi
