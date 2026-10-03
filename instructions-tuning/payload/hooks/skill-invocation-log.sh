#!/usr/bin/env bash
# PostToolUse(Skill) — append {ts, turn_uuid, skill} to the per-machine
# skill-invocations log. The OUTPUT (this jsonl schema + location) is the shared
# contract: skill-gate-guard.sh reads it to enforce skill-before-edit, and
# cc-learning-log's classifier reads it to attribute a behavior to its skill.
#
# Standalone: no _lib dependency, so this package installs without cc-learning-log.
# If cc-learning-log is also installed, the installer keeps whichever copy is
# already present (both emit identical jsonl). Never blocks.
#
# Input (stdin JSON): { cwd, tool_input: { skill }, transcript_path, ... }

set -u

# Recursion guard: a forked `claude -p` must never re-arm hooks.
[ -n "${CCLL_INACTIVE:-}" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat 2>/dev/null) || exit 0
[ -z "$input" ] && exit 0

skill=$(printf '%s' "$input" | jq -r '.tool_input.skill // empty' 2>/dev/null)
[ -z "$skill" ] && exit 0

cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
ROOT="${CLAUDE_PROJECT_DIR:-$cwd}"
[ -z "$ROOT" ] && ROOT="$(git -C "${cwd:-$PWD}" rev-parse --show-toplevel 2>/dev/null)"
[ -z "$ROOT" ] && ROOT="$PWD"
STATE_DIR="$ROOT/.claude/state"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
turn=""
[ -n "$transcript" ] && [ -f "$transcript" ] && \
  turn=$(jq -r 'select(.uuid)|.uuid' "$transcript" 2>/dev/null | tail -1)

# session_id lets skill-gate-guard.sh scope the gate to THIS session (parallel sessions share this log).
# agent_id (present only inside a subagent) scopes it further: a subagent shares its parent's session_id, but the
# parent's skill text is not in the subagent's context.
session=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
agent=$(printf '%s' "$input" | jq -r '.agent_id // empty' 2>/dev/null)
jq -nc --arg ts "$ts" --arg turn "$turn" --arg skill "$skill" --arg session "$session" --arg agent "$agent" \
  '{ts:$ts, turn_uuid:$turn, skill:$skill, session_id:$session, agent_id:$agent}' >> "$STATE_DIR/skill-invocations.jsonl" 2>/dev/null

exit 0
