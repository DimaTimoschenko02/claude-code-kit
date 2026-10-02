#!/usr/bin/env bash
# PreToolUse(Write|Edit|Bash) — skill-gate determinism enforcement.
#
# Blocks editing a "governed" file unless its OWNER skill was invoked since the
# last CONTEXT RESET — i.e. a skill-invocation ts >= max(session start, last
# /compact). Which paths require which skill is read from
# .claude/skill-gate.config.json (a "gates" array of {path_prefix|path_exact,
# skill}). No config / no match -> nothing gated.
#
# Why a hook, not prose: CLAUDE.md & SKILL.md are advisory ("no guarantee of
# strict compliance"). A "must happen every time" rule is a determinism failure
# -> only a hook guarantees it.
# Why this boundary: a skill's text persists in context across turns, so per-turn
# re-invocation is overkill — and unworkable, because tool_result entries are
# recorded as type:user, so a "last user message" boundary would advance past the
# invocation on every tool call. But /compact summarizes the skill text OUT of
# context, so a pre-compact invocation no longer counts.
#
# FAIL-OPEN: any missing input / unparseable state -> exit 0. The gate fires only
# when it can prove the required skill was NOT invoked since the boundary.
#
# Bash: a governed file edited with `sed -i` / a python heredoc went through ungated while the gate watched
# Write|Edit only. For Bash the targets come from _lib/bash-write-targets.py (writes only: redirect target, tee,
# sed -i, rm/mv, a writing interpreter heredoc — reads like `grep … > /tmp/x` stay free).
#
# Input (stdin JSON): { tool_name, tool_input: { file_path | command }, transcript_path, cwd }

set -u
# The parsers are part of the gate and live in _lib next to this file. The decision log belongs to the project:
# a project that runs the gate through the --link shim passes its own hook-log.sh in SKILL_GATE_LOG.
LIB="$(dirname "${BASH_SOURCE[0]}")/_lib"
. "${SKILL_GATE_LOG:-$LIB/hook-log.sh}" 2>/dev/null || hook_log() { :; }

# Recursion guard: a forked `claude -p` (e.g. a background classifier) is exempt.
[ -n "${CCLL_INACTIVE:-}" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat 2>/dev/null) || exit 0
[ -z "$input" ] && exit 0

transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)

ROOT="${CLAUDE_PROJECT_DIR:-$cwd}"
[ -z "$ROOT" ] && ROOT="$(pwd)"

CONFIG="$ROOT/.claude/skill-gate.config.json"
[ -f "$CONFIG" ] || exit 0   # no gates configured -> fail-open

if [ "$tool" = "Bash" ]; then
  targets=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null \
    | python3 -B "$LIB/bash-write-targets.py" "${cwd:-$ROOT}" 2>/dev/null)
else
  targets=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
fi
[ -z "$targets" ] && exit 0

# Which skill owns a path? First matching gate wins (prefix or exact).
# Bind fields to vars BEFORE the `$rel | ...` pipe — inside startswith(), `.`
# is $rel (a string), so `.path_prefix` there would index the string and error.
owner() {
  jq -r --arg rel "$1" '
    .gates[]?
    | (.path_prefix // null) as $p
    | (.path_exact // null) as $e
    | select( ($p != null and ($rel | startswith($p))) or ($e != null and ($rel == $e)) )
    | .skill' "$CONFIG" 2>/dev/null | head -1
}
gated=""   # "skill<TAB>path" per governed target
while IFS= read -r fp; do
  [ -z "$fp" ] && continue
  r="${fp#"$ROOT"/}"
  s=$(owner "$r")
  [ -n "$s" ] && gated+="$s"$'\t'"$r"$'\n'
done <<< "$targets"
[ -z "$gated" ] && exit 0   # no governed path written
hook_log pass

LOG="$ROOT/.claude/state/skill-invocations.jsonl"
[ -f "$LOG" ] || exit 0   # logger hasn't written yet -> fail-open

# Context-reset boundary = later of (session start, last /compact). Compaction is
# recorded as a type:user entry with isCompactSummary:true; otherwise the earliest
# transcript timestamp is the session start.
boundary=""
if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  boundary=$(grep 'isCompactSummary' "$transcript" 2>/dev/null \
    | jq -rc 'select(.isCompactSummary==true)|.timestamp' 2>/dev/null | tail -1)
  # Session start = first entry with a TOP-LEVEL .timestamp. Don't grep for the
  # bare string: the transcript opens with a `file-history-snapshot` entry whose
  # timestamp is nested under .snapshot, so `grep -m1 '"timestamp"' | jq .timestamp`
  # yields null -> empty boundary -> the gate fail-opens for the WHOLE session
  # (observed 2026-08-01: a new file under a governed path was written ungated).
  # head -N keeps this cheap — the session start is always in the first lines.
  [ -z "$boundary" ] && boundary=$(head -100 "$transcript" 2>/dev/null \
    | jq -rc 'select(.timestamp != null) | .timestamp' 2>/dev/null | head -1)
fi
[ -z "$boundary" ] && exit 0   # can't locate boundary -> fail-open

# Most recent invocation ts of the required skill (ISO8601 UTC -> lexicographic compare valid).
# Directory-scoped skills are logged with a scope prefix ("myrepo:vault-write"), so accept "<scope>:<skill>" too.
# Only this session's invocations count: parallel sessions share the log, and another window's /skill must not open
# this one's gate. A record without session_id (logged before the field existed) still counts — fail-open, as above.
sid=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
req="" rel=""
while IFS=$'\t' read -r s r; do
  [ -z "$s" ] && continue
  invoked=$(jq -r --arg s "$s" --arg sid "$sid" \
    'select(.skill==$s or (.skill|endswith(":"+$s))) | select($sid == "" or (.session_id // "") == "" or .session_id == $sid) | .ts' \
    "$LOG" 2>/dev/null | tail -1)
  if [ -n "$invoked" ] && { [[ "$invoked" > "$boundary" ]] || [ "$invoked" = "$boundary" ]; }; then
    continue
  fi
  req="$s" rel="$r"
  break
done <<< "$gated"
[ -z "$req" ] && exit 0   # every governed target's owner skill is loaded

hook_log deny "$req"
cat >&2 <<EOF
🚧 skill-gate: editing "${rel}" requires the owner skill /${req}, but /${req} has
not been invoked since the last context reset (session start or /compact).
Invoke /${req} FIRST, then retry the edit.  (gates: .claude/skill-gate.config.json)
EOF
exit 2
