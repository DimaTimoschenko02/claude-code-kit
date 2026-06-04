#!/usr/bin/env bash
# PostToolUse(Skill) hook — append {ts, turn_uuid, skill} to the per-machine
# skill-invocations log. The classifier correlates these with the transcript so
# it can attribute a behavior to the skill that was active. Never blocks.
#
# Input (stdin JSON): { cwd, tool_input: { skill }, transcript_path, ... }

set -u

# Recursion guard: a forked `claude -p` must never re-arm our hooks.
[ -n "${CCLL_INACTIVE:-}" ] && exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$SCRIPT_DIR/_lib/env.sh" ]   && . "$SCRIPT_DIR/_lib/env.sh"
[ -f "$SCRIPT_DIR/_lib/paths.sh" ] && . "$SCRIPT_DIR/_lib/paths.sh"

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat 2>/dev/null) || exit 0
[ -z "$input" ] && exit 0

skill=$(printf '%s' "$input" | jq -r '.tool_input.skill // empty' 2>/dev/null)
[ -z "$skill" ] && exit 0

cwd_hint=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
PROJECT_ROOT="$(resolve_project_root "$cwd_hint")"
STATE_DIR="$PROJECT_ROOT/.claude/state"
mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
turn=""
[ -n "$transcript" ] && [ -f "$transcript" ] && \
  turn=$(jq -r 'select(.uuid)|.uuid' "$transcript" 2>/dev/null | tail -1)

jq -nc --arg ts "$ts" --arg turn "$turn" --arg skill "$skill" \
  '{ts:$ts, turn_uuid:$turn, skill:$skill}' >> "$STATE_DIR/skill-invocations.jsonl" 2>/dev/null

exit 0
