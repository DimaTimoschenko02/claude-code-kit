#!/usr/bin/env bash
# PreToolUse(Write|Edit) — skill-gate determinism enforcement.
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
# Input (stdin JSON): { tool_input: { file_path }, transcript_path, cwd }

set -u

# Recursion guard: a forked `claude -p` (e.g. a background classifier) is exempt.
[ -n "${CCLL_INACTIVE:-}" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat 2>/dev/null) || exit 0
[ -z "$input" ] && exit 0

fp=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$fp" ] && exit 0
transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)

ROOT="${CLAUDE_PROJECT_DIR:-$cwd}"
[ -z "$ROOT" ] && ROOT="$(pwd)"
rel="${fp#"$ROOT"/}"

CONFIG="$ROOT/.claude/skill-gate.config.json"
[ -f "$CONFIG" ] || exit 0   # no gates configured -> fail-open

# Which skill owns this path? First matching gate wins (prefix or exact).
# Bind fields to vars BEFORE the `$rel | ...` pipe — inside startswith(), `.`
# is $rel (a string), so `.path_prefix` there would index the string and error.
req=$(jq -r --arg rel "$rel" '
  .gates[]?
  | (.path_prefix // null) as $p
  | (.path_exact // null) as $e
  | select( ($p != null and ($rel | startswith($p))) or ($e != null and ($rel == $e)) )
  | .skill' "$CONFIG" 2>/dev/null | head -1)
[ -z "$req" ] && exit 0   # path not governed

LOG="$ROOT/.claude/state/skill-invocations.jsonl"
[ -f "$LOG" ] || exit 0   # logger hasn't written yet -> fail-open

# Context-reset boundary = later of (session start, last /compact). Compaction is
# recorded as a type:user entry with isCompactSummary:true; otherwise the earliest
# transcript timestamp is the session start.
boundary=""
if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  boundary=$(grep 'isCompactSummary' "$transcript" 2>/dev/null \
    | jq -rc 'select(.isCompactSummary==true)|.timestamp' 2>/dev/null | tail -1)
  [ -z "$boundary" ] && boundary=$(grep -m1 '"timestamp"' "$transcript" 2>/dev/null \
    | jq -r '.timestamp // empty' 2>/dev/null)
fi
[ -z "$boundary" ] && exit 0   # can't locate boundary -> fail-open

# Most recent invocation ts of the required skill (ISO8601 UTC -> lexicographic compare valid).
invoked=$(jq -r --arg s "$req" 'select(.skill==$s)|.ts' "$LOG" 2>/dev/null | tail -1)

if [ -n "$invoked" ] && { [[ "$invoked" > "$boundary" ]] || [ "$invoked" = "$boundary" ]; }; then
  exit 0
fi

cat >&2 <<EOF
🚧 skill-gate: editing "${rel}" requires the owner skill /${req}, but /${req} has
not been invoked since the last context reset (session start or /compact).
Invoke /${req} FIRST, then retry the edit.  (gates: .claude/skill-gate.config.json)
EOF
exit 2
