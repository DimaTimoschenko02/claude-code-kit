#!/usr/bin/env bash
# Shared by pre-commit (staged lines) and commit-msg (the message): prints the lines of stdin that carry
# personal or workspace-specific content, exits 1 when there are any.
#
# Why three sources and not one list: this repo is public, so a list of the owner's project names, people and
# folders cannot live in it — writing it here would publish exactly what it guards. The public part names only
# generic leaks; the owner's identity is computed from the machine; the owner's own words come from a file
# outside the repo.
#   1. PUBLIC  — generic workspace paths and words, below.
#   2. MACHINE — login name, home folder name, git user.name and the e-mail's local part. They are what a
#                pasted path (C--Users-<login>-…), a home path or an author line leaks.
#   3. PRIVATE — one extended regex per line (# comments) in $KIT_PRIVATE_PATTERNS, else `git config
#                kit.privatePatterns`, else ~/.config/claude-code-kit/private-patterns: project names, people,
#                repo slugs. A line starting with `!` is an allow pattern instead: lines matching it are skipped —
#                for attribution the owner publishes on purpose (LICENSE, plugin author, the clone URL).
# Plus real Claude Code session ids: a UUID that names a transcript under ~/.claude/projects is a session of
# this machine pasted into a test or a comment.
set -uo pipefail

PUBLIC='~/work|/Users/|sharkscode|casino|bestsrv|jira'

alts=()
allows=()
add_word() {   # whole-word match: a short login inside a longer word is not a leak
  local w="$1"
  [ "${#w}" -ge 4 ] || return 0
  w="$(printf '%s' "$w" | sed 's/[][\.*^$+?(){}|/]/\\&/g')"
  alts+=("(^|[^[:alnum:]])${w}([^[:alnum:]]|$)")
}
add_word "$(id -un 2>/dev/null || true)"
add_word "$(basename "${HOME:-}")"
add_word "$(git config user.name 2>/dev/null || true)"
email="$(git config user.email 2>/dev/null || true)"
add_word "${email%%@*}"

priv="${KIT_PRIVATE_PATTERNS:-$(git config kit.privatePatterns 2>/dev/null || true)}"
priv="${priv:-$HOME/.config/claude-code-kit/private-patterns}"
priv="${priv/#\~/$HOME}"
if [ -f "$priv" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; '!'*) allows+=("${line#!}"); continue ;; esac
    alts+=("$line")
  done < "$priv"
fi

PATTERN="$PUBLIC"
for a in "${alts[@]+"${alts[@]}"}"; do PATTERN="$PATTERN|$a"; done

input="$(tr -d "\000")"
for a in "${allows[@]+"${allows[@]}"}"; do input="$(printf '%s\n' "$input" | grep -viE "$a" || true)"; done
[ -z "$input" ] && exit 0
hits="$(printf '%s\n' "$input" | grep -inE "$PATTERN" || true)"

projects="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"
projects="${projects//\\//}"   # a Windows path from the environment: Git Bash globs only forward slashes
if [ -d "$projects" ]; then
  for u in $(printf '%s\n' "$input" | grep -oiE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | sort -u); do
    if compgen -G "$projects/*/$u.jsonl" >/dev/null; then hits="$hits${hits:+$'\n'}session id of this machine: $u"; fi
  done
fi

[ -z "$hits" ] && exit 0
printf '%s\n' "$hits" | head -10 | sed 's/^/   /'
exit 1
