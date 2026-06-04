#!/usr/bin/env bash
# Generic project-root resolution — NO hardcoded project name.
#
# resolve_project_root [cwd_hint]
#   Priority: $CLAUDE_PROJECT_DIR  ->  git toplevel of cwd_hint (else cwd_hint)
#             ->  script-location fallback (.claude/hooks/_lib -> project root).
#
# Hooks pass the `cwd` field from the hook stdin JSON as the hint. The
# script-location fallback assumes this lib lives at <root>/.claude/hooks/_lib/.

resolve_project_root() {
  local hint="${1:-}" top
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "$CLAUDE_PROJECT_DIR" ]; then
    printf '%s\n' "$CLAUDE_PROJECT_DIR"; return 0
  fi
  if [ -n "$hint" ] && [ -d "$hint" ]; then
    top=$(git -C "$hint" rev-parse --show-toplevel 2>/dev/null)
    printf '%s\n' "${top:-$hint}"; return 0
  fi
  # BASH_SOURCE[1] = the hook that sourced this lib (.claude/hooks/<hook>.sh).
  ( cd "$(dirname "${BASH_SOURCE[1]}")/../.." && pwd )
}
