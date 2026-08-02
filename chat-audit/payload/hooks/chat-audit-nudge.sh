#!/usr/bin/env bash
# UserPromptSubmit — a request to look back over past chats must go through the
# chat-audit skill.
#
# Why a hook and not a line in CLAUDE.md: this exact request ("re-read the last
# chats and find what could be better") is the one that reliably produces two
# vague bullets. The model does not think it needs a skill for it — it reads as
# a simple question. So the reminder has to arrive with the prompt itself.
#
# Advisory only: it injects context, never blocks. Fires once per session unless
# the skill was already invoked.
set -uo pipefail

STATE_DIR="${CLAUDE_PROJECT_DIR:-$PWD}/.claude/state/chat-audit"
CONFIG="${CLAUDE_PROJECT_DIR:-$PWD}/.claude/chat-audit.config.json"

input="$(cat)"
prompt="$(printf '%s' "$input" | sed -n 's/.*"prompt"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -c 4000)"
[ -z "$prompt" ] && exit 0

session="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[ -z "$session" ] && session="unknown"

# Opt-out without uninstalling.
if [ -f "$CONFIG" ] && grep -q '"nudge"[[:space:]]*:[[:space:]]*false' "$CONFIG" 2>/dev/null; then
  exit 0
fi

# Subject (chats/sessions/history/transcripts) AND intent (analyse/improve/faster).
subject='чат|сесси|сесій|сесі|истори|історі|транскрипт|переписк|chat|session|transcript|history|last conversations'
intent='перечита|пройди|проанализ|проаналіз|разбер|розбер|аудит|audit|analy[sz]|review|быстрее|швидше|эффективн|ефективн|faster|better|improve|optimi|где я|де я|что можно было|що можна було|без моих указан|без моїх вказ|what could|where could'

lower="$(printf '%s' "$prompt" | tr '[:upper:]' '[:lower:]')"
printf '%s' "$lower" | grep -qE "$subject" || exit 0
printf '%s' "$lower" | grep -qE "$intent"  || exit 0

mkdir -p "$STATE_DIR" 2>/dev/null || exit 0
marker="$STATE_DIR/nudged-$session"
[ -f "$marker" ] && exit 0
: > "$marker"

# Best-effort cleanup of markers older than a week.
find "$STATE_DIR" -name 'nudged-*' -type f -mtime +7 -delete 2>/dev/null

cat <<'MSG'
<system-reminder>
This is a request to look back over past sessions. Invoke the `chat-audit` skill before answering.

Answering directly is the failure mode this skill exists for: without establishing the goal, the lens and
what a finding will become, the honest answer to "find where it could be better" is a couple of vague
bullets. The skill runs intake first, then reads transcripts with deterministic extractors instead of by eye.
</system-reminder>
MSG
exit 0
