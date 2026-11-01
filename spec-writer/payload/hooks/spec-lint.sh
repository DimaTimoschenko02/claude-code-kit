#!/usr/bin/env bash
# spec-lint hook — PostToolUse(Write|Edit): after a spec file is written, check it against the spec-writer contract and
# hand the errors back to the model (decision: block) so it fixes them before the spec reaches a coder.
# Which files are specs, and in which language, comes from the project's .claude/spec-writer.project.md; without that
# file, or for any other path, the hook is silent. The write itself is never stopped by a broken linter.
# Not silent when it cannot lint: the linter sits in the skill folder, under `install.sh --link` a gitignored link into
# the kit clone, and a machine without that link linted nothing for days while every check said fine. So in a project
# with spec-writer.project.md a missing linter, a missing node or a crash is told to the session — once per session, at
# its first .md write, so a session writing ten notes hears it once. No extra process on the healthy path.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
linter="$here/../skills/spec-writer/scripts/spec-lint.mjs"
input="$(cat)"
[[ $input =~ \"file_path\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]] && file="${BASH_REMATCH[1]}" || file=""

warn_once() {
  [ -f "$here/../spec-writer.project.md" ] || exit 0
  case "$file" in *.md) ;; *) exit 0 ;; esac
  [[ $input =~ \"session_id\"[[:space:]]*:[[:space:]]*\"([^\"]*)\" ]] && sid="${BASH_REMATCH[1]//[^A-Za-z0-9_-]/}" || sid=nosession
  mark="${TMPDIR:-/tmp}/spec-lint-warned-$sid"
  [ -f "$mark" ] && exit 0
  : > "$mark" 2>/dev/null
  local m="⚠ spec-lint: $1 — specs written in this session are NOT checked against the spec contract."
  m="${m//\\/\\\\}"; m="${m//\"/\\\"}"; m="${m//$'\r'/}"; m="${m//$'\n'/ }"
  printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' "$m" "$m"
  exit 0
}

FIX="fix: node ~/claude-code-kit/bin/kit-links.mjs --fix <project> (or spec-writer/install.sh --link --no-register <project>)"
command -v node >/dev/null 2>&1 || warn_once "node not found"
[ -f "$linter" ] || warn_once "linter not found at .claude/skills/spec-writer/scripts/spec-lint.mjs (the kit link is missing on this machine); $FIX"
# The linter's stdout (the block decision) goes straight to the hook's stdout; only its stderr is caught.
exec 3>&1
err="$(printf '%s' "$input" | node "$linter" --hook 2>&1 >&3)"; rc=$?
exec 3>&-
[ "$rc" = 0 ] || warn_once "the linter failed (exit $rc): ${err%%$'\n'*}"
exit 0
