#!/usr/bin/env bash
# Background classifier — forked by learning-log-trigger.sh.
# Reads the transcript chunk since this session's anchor, calls Claude haiku via
# `claude -p` (uses the Max/Pro subscription, NOT the paid API), parses the JSON
# response, and prepends new entries to today's day file:
#   <project>/.claude/learning-log/<YYYY-MM>/<YYYY-MM-DD>.md
#
# Args:
#   $1 — transcript_path (JSONL)
#   $2 — state_file (.claude/state/learning-log.json)
#   $3 — project_root (resolved by the trigger; re-derived if absent)
#
# Errors go to .claude/state/analyze-errors.log — never to stdout.
# Lock: .claude/state/.analyze.lock.d (mkdir-atomic; macOS has no flock).

set -u

TRANSCRIPT_PATH="${1:-}"
STATE_FILE="${2:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Restore PATH for nvm/brew/native binaries — nohup'd forks inherit a stripped env.
[ -f "$SCRIPT_DIR/_lib/env.sh" ]   && . "$SCRIPT_DIR/_lib/env.sh"
[ -f "$SCRIPT_DIR/_lib/paths.sh" ] && . "$SCRIPT_DIR/_lib/paths.sh"

[ -z "$TRANSCRIPT_PATH" ] || [ ! -f "$TRANSCRIPT_PATH" ] && exit 0
[ -z "$STATE_FILE" ] || [ ! -f "$STATE_FILE" ] && exit 0

PROJECT_ROOT="${3:-}"
if [ -z "$PROJECT_ROOT" ] || [ ! -d "$PROJECT_ROOT" ]; then
  PROJECT_ROOT="$(resolve_project_root "")"
fi
# Never write logs into the global plugin cache.
case "$PROJECT_ROOT" in *"/.claude/plugins/"*) exit 0 ;; esac

LL_CLAUDE_DIR="$PROJECT_ROOT/.claude"
[ -f "$SCRIPT_DIR/_lib/config.sh" ] && . "$SCRIPT_DIR/_lib/config.sh"

STATE_DIR="$LL_CLAUDE_DIR/state"
ERROR_LOG="$STATE_DIR/analyze-errors.log"
LOCK_DIR="$STATE_DIR/.analyze.lock.d"
SKILL_LOG="$STATE_DIR/skill-invocations.jsonl"
LEARNING_LOG_DIR="$LL_CLAUDE_DIR/learning-log"

mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

log_err() {
  local ts; ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '%s — %s\n' "$ts" "$*" >> "$ERROR_LOG" 2>/dev/null
}

# Dependency checks. Silent exit on missing tooling.
for bin in jq claude; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    log_err "missing dependency: $bin"
    exit 0
  fi
done

# --- Acquire lock (mkdir is atomic; reclaim if stale) ---
if [ -d "$LOCK_DIR" ]; then
  mt=$(stat -f %m "$LOCK_DIR" 2>/dev/null || stat -c %Y "$LOCK_DIR" 2>/dev/null)
  [ -n "$mt" ] && [ $(( ( $(date +%s) - mt ) / 60 )) -ge "$LL_STALE_LOCK_MINUTES" ] && rmdir "$LOCK_DIR" 2>/dev/null
fi
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0  # another analyze is running
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT INT TERM

# --- Build transcript chunk (per-session anchor) ---
SID=$(basename "$TRANSCRIPT_PATH" .jsonl)
last_uuid=$(jq -r --arg s "$SID" '.anchors[$s] // empty' "$STATE_FILE" 2>/dev/null)

if [ -n "$last_uuid" ] && ! grep -q "$last_uuid" "$TRANSCRIPT_PATH" 2>/dev/null; then
  last_uuid=""
fi

if [ -n "$last_uuid" ]; then
  chunk=$(awk -v anchor="$last_uuid" '
    BEGIN { found=0 }
    found { print; next }
    $0 ~ anchor { found=1 }
  ' "$TRANSCRIPT_PATH" 2>/dev/null)
else
  chunk=$(cat "$TRANSCRIPT_PATH" 2>/dev/null)
fi

if [ -z "$chunk" ]; then
  log_err "empty chunk (no new turns since anchor for session $SID)"
  exit 0
fi

# --- Truncate oversized chunk: keep the LAST bytes; drop the first partial line ---
if [ "$(printf '%s' "$chunk" | wc -c)" -gt "$LL_MAX_CHUNK_BYTES" ]; then
  chunk=$(printf '%s' "$chunk" | tail -c "$LL_MAX_CHUNK_BYTES" | sed '1d')
  log_err "info: chunk truncated to last ${LL_MAX_CHUNK_BYTES} bytes (long backlog, session $SID)"
fi

# Compact the chunk to a human-readable form for haiku (drop noise fields).
chunk_compact=$(printf '%s\n' "$chunk" | jq -c '{
  uuid: (.uuid // null),
  role: (.message.role // null),
  text: (
    if (.message.content // "") | type == "string" then .message.content
    elif (.message.content // []) | type == "array" then
      (.message.content | map(select(type=="object" and .type=="text") | .text) | join("\n"))
    else null end
  ),
  tool_name: (.message.content // [] | if type=="array" then
    (map(select(type=="object" and .type=="tool_use") | .name) | first) else null end)
}' 2>/dev/null | jq -sc . 2>/dev/null)

if [ -z "$chunk_compact" ] || [ "$chunk_compact" = "null" ]; then
  log_err "failed to compact transcript chunk"
  exit 0
fi

# --- Build skills-context (PostToolUse log) ---
skills_context="[]"
if [ -f "$SKILL_LOG" ]; then
  skills_context=$(tail -n "$LL_SKILL_LOG_LOOKBACK" "$SKILL_LOG" 2>/dev/null | jq -sc '.' 2>/dev/null)
  [ -z "$skills_context" ] && skills_context="[]"
fi

# --- Build prompt (literal heredoc + token substitution; no escape traps) ---
read -r -d '' SYSTEM_PROMPT <<'EOF' || true
You analyze a conversation between Claude (an AI coding assistant) and __PERSONA__.
Your job: find moments worth logging as learning signals. TWO classes count:

1. "user-correction" — __PERSONA__ tells Claude it did something wrong, should
   have done something else, or expresses frustration about a mistake.
2. "self-correction" — Claude itself notices and fixes its own mistake, or
   admits doing something suboptimal, WITHOUT being told first.

Output a JSON array. Each item describes one event:

{
  "class": "user-correction | self-correction",
  "did": "what Claude actually did (1-2 sentences, past tense, in __LANGUAGE__)",
  "wanted": "what should have happened instead (1 sentence, in __LANGUAGE__)",
  "cause_hypothesis": "skill | claude-md | memory | habit | unknown",
  "cause_explanation": "1 short phrase in __LANGUAGE__ explaining the hypothesis",
  "related_skill_or_file": "name of skill or file if related, else null",
  "turn_uuid": "uuid of the relevant turn"
}

Rules:
- Return BOTH clear user-corrections AND clear self-corrections.
- DO NOT invent. If there is no clear correction of either class, return [].
- DO NOT include corrections about formatting, typos, or content nuances.
  Focus on behavioral/process mistakes (Claude did X, should have done Y).
- The "related_skill_or_file" field: cross-reference the provided skills_invoked
  list. If the event happened while a specific skill was active, name that skill.

Output ONLY a JSON array. No prose, no explanation, no markdown fences.
EOF

SYSTEM_PROMPT="${SYSTEM_PROMPT//__PERSONA__/$LL_PERSONA}"
SYSTEM_PROMPT="${SYSTEM_PROMPT//__LANGUAGE__/$LL_LANGUAGE}"
if [ -n "$LL_EXTRA" ]; then
  SYSTEM_PROMPT="$SYSTEM_PROMPT

Additional project-specific guidance:
$LL_EXTRA"
fi

user_content=$(jq -nc \
  --argjson transcript "$chunk_compact" \
  --argjson skills "$skills_context" \
  '{transcript: $transcript, skills_invoked: $skills}' 2>/dev/null)

if [ -z "$user_content" ]; then
  log_err "failed to build user_content JSON"
  exit 0
fi

combined_prompt=$(printf '%s\n\n---\n\nINPUT:\n%s' "$SYSTEM_PROMPT" "$user_content")

# --- Call haiku via claude -p ---
# CCLL_INACTIVE disarms our hooks inside the fork (no recursion).
# force_subscription unsets ANTHROPIC_API_KEY so an exported key can't silently
# route to the billed API. timeout caps a hung call (if available).
CALL=(env)
[ "$LL_FORCE_SUB" = "true" ] && CALL+=(-u ANTHROPIC_API_KEY)
CALL+=(CCLL_INACTIVE=1)
TO_BIN="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"
[ -n "$TO_BIN" ] && CALL+=("$TO_BIN" "$LL_TIMEOUT")
CALL+=(claude -p --model "$LL_MODEL")

response=$(printf '%s' "$combined_prompt" | "${CALL[@]}" 2>>"$ERROR_LOG")

if [ -z "$response" ]; then
  log_err "empty response from claude -p (auth? timeout? network?)"
  exit 0
fi

# Strip potential markdown code fences.
response_clean=$(printf '%s' "$response" | sed -e 's/^```json//' -e 's/^```//' -e 's/```$//' | sed '/^[[:space:]]*$/d')

if ! printf '%s' "$response_clean" | jq -e 'type == "array"' >/dev/null 2>&1; then
  log_err "haiku response is not a JSON array: $(printf '%s' "$response_clean" | head -c 200)"
  exit 0
fi

entry_count=$(printf '%s' "$response_clean" | jq 'length' 2>/dev/null)
[ -z "$entry_count" ] && entry_count=0

# Update this session's anchor regardless of findings — chunk has been scanned.
# Pick the last line that actually HAS a uuid (tail -n1 may hit a non-message line).
latest_uuid=$(jq -r 'select(.uuid)|.uuid' "$TRANSCRIPT_PATH" 2>/dev/null | tail -1)
now_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if [ -n "$latest_uuid" ]; then
  jq --arg u "$latest_uuid" --arg t "$now_iso" --arg s "$SID" \
    '.anchors = (.anchors // {}) | .anchors[$s] = $u | .last_run_at = $t' \
    "$STATE_FILE" > "$STATE_FILE.tmp" 2>/dev/null && mv "$STATE_FILE.tmp" "$STATE_FILE"
fi

# Cap the skill-invocations log (runs whether or not we found entries).
if [ -f "$SKILL_LOG" ]; then
  _sl_tmp=$(mktemp "$STATE_DIR/.sl.XXXXXX" 2>/dev/null) && {
    tail -n 500 "$SKILL_LOG" > "$_sl_tmp" 2>/dev/null && mv "$_sl_tmp" "$SKILL_LOG" 2>/dev/null || rm -f "$_sl_tmp"
  }
fi

if [ "$entry_count" -eq 0 ]; then
  exit 0
fi

# --- Format entries as markdown ---
session_short="${SID:0:8}"
ts_local=$(date +%H:%M)     # entry header is HH:MM (date lives in folder/filename)
today=$(date +%Y-%m-%d)
month=$(date +%Y-%m)

entries_md=$(printf '%s' "$response_clean" | jq -r --arg ts "$ts_local" --arg conv "$session_short" --arg wl "$LL_WIKILINKS" '
  .[] |
  "## " + $ts + "\n" +
  "- **Did:** " + (.did // "—") + "\n" +
  "- **Wanted:** " + (.wanted // "—") + "\n" +
  "- **Cause:** " + (.cause_hypothesis // "unknown") + " — " + (.cause_explanation // "—") + "\n" +
  "- **Related:** " + (
    if (.related_skill_or_file // null) == null or (.related_skill_or_file // "") == "" then "—"
    elif $wl == "true" then "[[" + .related_skill_or_file + "]]"
    else "`" + .related_skill_or_file + "`"
    end
  ) + "\n" +
  "- **Status:** open\n" +
  "- **Source:** auto (haiku, " + (.class // "user-correction") + ", conv=" + $conv + ", turn=" + (.turn_uuid // "?")[0:8] + ")\n"
' 2>/dev/null)

if [ -z "$entries_md" ]; then
  log_err "failed to format entries to markdown"
  exit 0
fi

# --- Write entries to today's day file (prepend, newest on top) ---
DAY_DIR="$LEARNING_LOG_DIR/$month"
DAY_FILE="$DAY_DIR/$today.md"

if ! mkdir -p "$DAY_DIR" 2>/dev/null; then
  log_err "failed to mkdir day dir: $DAY_DIR"
  exit 0
fi

if [ ! -f "$DAY_FILE" ]; then
  printf '# Learning Log — %s\n' "$today" > "$DAY_FILE" 2>/dev/null \
    || { log_err "failed to create day file: $DAY_FILE"; exit 0; }
fi

# Insert before the first existing '## HH:MM' (newest on top), or after the H1 if
# none. Entries are read from a FILE (not `awk -v`): awk -v interprets backslash
# escapes and special markdown chars silently break it (empty output — a real bug
# hit during development). mktemp lives next to the dest so mv is a same-fs rename.
TMP=$(mktemp "$DAY_DIR/.day.XXXXXX" 2>/dev/null) || { log_err "mktemp failed"; exit 0; }
ENTRIES_TMP=$(mktemp "$DAY_DIR/.ent.XXXXXX" 2>/dev/null) || { log_err "mktemp failed"; rm -f "$TMP"; exit 0; }
printf '%s\n' "$entries_md" > "$ENTRIES_TMP"

awk '
  NR==FNR { buf = buf $0 ORS; next }
  /^## [0-9][0-9]:[0-9][0-9]/ && !inserted { printf "%s", buf; inserted=1 }
  { print }
  END { if (!inserted) { print ""; printf "%s", buf } }
' "$ENTRIES_TMP" "$DAY_FILE" > "$TMP" 2>/dev/null
rm -f "$ENTRIES_TMP"

if [ -s "$TMP" ]; then
  mv "$TMP" "$DAY_FILE" 2>/dev/null || { log_err "failed to replace day file"; rm -f "$TMP"; exit 0; }
else
  log_err "awk produced empty output"
  rm -f "$TMP"
  exit 0
fi

exit 0
