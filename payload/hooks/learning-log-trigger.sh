#!/usr/bin/env bash
# Stop / SessionEnd hook — forks the background haiku classifier
# (learning-log-analyze.sh) when enough new conversation has accumulated.
#
# Fire conditions:
#   - SessionEnd -> fire if ANY new message since last analysis (final flush)
#   - Stop       -> fire if >= threshold new user/assistant messages
#
# No regex prefilter, no turn counter: the haiku classifier itself decides
# SEMANTICALLY whether the chunk holds a correction. This hook only throttles by
# message VOLUME. Manual catch-up: `/learning-log flush`.
#
# Never blocks: always exits 0 quickly. The fork uses nohup so it survives exit.
#
# Input (stdin JSON): { session_id, transcript_path, hook_event_name, cwd, ... }

set -u

# Recursion guard: the classifier runs `claude -p`, which could itself emit Stop.
# CCLL_INACTIVE is set in the fork's env, so a nested invocation exits here.
[ -n "${CCLL_INACTIVE:-}" ] && exit 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$SCRIPT_DIR/_lib/env.sh" ]   && . "$SCRIPT_DIR/_lib/env.sh"
[ -f "$SCRIPT_DIR/_lib/paths.sh" ] && . "$SCRIPT_DIR/_lib/paths.sh"

command -v jq >/dev/null 2>&1 || exit 0

input=$(cat 2>/dev/null) || exit 0
[ -z "$input" ] && exit 0

session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
transcript_path=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
hook_event=$(printf '%s' "$input" | jq -r '.hook_event_name // empty' 2>/dev/null)
cwd_hint=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)

[ -z "$transcript_path" ] || [ ! -f "$transcript_path" ] && exit 0

PROJECT_ROOT="$(resolve_project_root "$cwd_hint")"
# Safety: never operate inside the global plugin cache.
case "$PROJECT_ROOT" in *"/.claude/plugins/"*) exit 0 ;; esac

LL_CLAUDE_DIR="$PROJECT_ROOT/.claude"
[ -f "$SCRIPT_DIR/_lib/config.sh" ] && . "$SCRIPT_DIR/_lib/config.sh"
[ "$LL_ENABLED" = "true" ] || exit 0

STATE_DIR="$LL_CLAUDE_DIR/state"
STATE_FILE="$STATE_DIR/learning-log.json"
LOCK_DIR="$STATE_DIR/.analyze.lock.d"
ANALYZE_SCRIPT="$SCRIPT_DIR/learning-log-analyze.sh"

mkdir -p "$STATE_DIR" 2>/dev/null || exit 0

# Initialize state file if missing.
if [ ! -f "$STATE_FILE" ]; then
  echo '{"anchors":{},"last_run_at":null,"last_session_id":null}' > "$STATE_FILE" 2>/dev/null || exit 0
fi

# Per-session anchor: each chat remembers its OWN last-analyzed turn.
last_uuid=$(jq -r --arg s "$session_id" '.anchors[$s] // empty' "$STATE_FILE" 2>/dev/null)

# If the anchor isn't in THIS transcript, treat the whole file as new (the slice
# would otherwise be silently empty). analyze.sh truncates oversized chunks.
if [ -n "$last_uuid" ] && ! grep -q "$last_uuid" "$transcript_path" 2>/dev/null; then
  last_uuid=""
fi

# Record current session id; ensure .anchors exists.
_st_tmp=$(mktemp "$STATE_DIR/.st.XXXXXX" 2>/dev/null) && \
  jq --arg s "$session_id" '.last_session_id = $s | .anchors = (.anchors // {})' \
    "$STATE_FILE" > "$_st_tmp" 2>/dev/null && mv "$_st_tmp" "$STATE_FILE" || rm -f "$_st_tmp"

# --- Slice transcript chunk since last analysis ---
if [ -n "$last_uuid" ]; then
  chunk=$(awk -v anchor="$last_uuid" '
    BEGIN { found=0 }
    found { print; next }
    $0 ~ anchor { found=1 }
  ' "$transcript_path" 2>/dev/null)
else
  chunk=$(cat "$transcript_path" 2>/dev/null)
fi

[ -z "$chunk" ] && exit 0

# --- Count NEW real messages (text-bearing user/assistant turns only) ---
msg_count=$(printf '%s\n' "$chunk" | jq -rR 'fromjson? // empty |
  select(
    (.message.role == "user" or .message.role == "assistant")
    and (
      ((.message.content | type) == "string" and (.message.content | length) > 0)
      or ((.message.content | type) == "array"
          and ((.message.content | map(select(.type == "text" and (.text | length) > 0)) | length) > 0))
    )
  ) | .uuid
' 2>/dev/null | grep -c .)

[ -z "$msg_count" ] && msg_count=0

# --- Decide whether to fire ---
should_fire=0
if [ "$hook_event" = "SessionEnd" ]; then
  [ "$msg_count" -ge 1 ] && should_fire=1
elif [ "$msg_count" -ge "$LL_THRESHOLD" ]; then
  should_fire=1
fi

[ "$should_fire" -eq 0 ] && exit 0

# --- Skip an obviously redundant fork if an analyze is already running ---
if [ -d "$LOCK_DIR" ]; then
  # GNU stat first (-c), BSD/macOS fallback (-f); guard against non-numeric output.
  mt=$(stat -c %Y "$LOCK_DIR" 2>/dev/null || stat -f %m "$LOCK_DIR" 2>/dev/null)
  case "$mt" in
    ''|*[!0-9]*) exit 0 ;;  # can't determine age -> assume active
    *)
      if [ $(( ( $(date +%s) - mt ) / 60 )) -ge "$LL_STALE_LOCK_MINUTES" ]; then
        rmdir "$LOCK_DIR" 2>/dev/null   # stale -> reclaim
      else
        exit 0                           # active lock
      fi
      ;;
  esac
fi

# Fork the background analyzer. CCLL_INACTIVE disarms hooks inside the fork.
if [ -f "$ANALYZE_SCRIPT" ]; then
  CCLL_INACTIVE=1 nohup bash "$ANALYZE_SCRIPT" "$transcript_path" "$STATE_FILE" "$PROJECT_ROOT" >/dev/null 2>&1 &
  disown 2>/dev/null || true
fi

exit 0
