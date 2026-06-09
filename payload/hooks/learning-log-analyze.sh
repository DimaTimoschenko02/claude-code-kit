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
  # GNU stat first (-c), BSD/macOS fallback (-f); guard against non-numeric output.
  mt=$(stat -c %Y "$LOCK_DIR" 2>/dev/null || stat -f %m "$LOCK_DIR" 2>/dev/null)
  case "$mt" in
    ''|*[!0-9]*) : ;;  # can't determine age -> leave the lock alone
    *) [ $(( ( $(date +%s) - mt ) / 60 )) -ge "$LL_STALE_LOCK_MINUTES" ] && rmdir "$LOCK_DIR" 2>/dev/null ;;
  esac
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

# With NO anchor, scan only the TAIL — never the whole file. Whole-file rescans
# re-classify already-logged turns and spam duplicates (one turn can land N×
# across sessions on resumed/forked transcripts). The trigger fires on new
# activity, so the tail covers the unprocessed window; content dedup (below)
# catches any overlap. Override via LL_NO_ANCHOR_TAIL_LINES in config.
no_anchor_tail="${LL_NO_ANCHOR_TAIL_LINES:-40}"
if [ -n "$last_uuid" ]; then
  chunk=$(awk -v anchor="$last_uuid" '
    BEGIN { found=0 }
    found { print; next }
    $0 ~ anchor { found=1 }
  ' "$TRANSCRIPT_PATH" 2>/dev/null)
else
  chunk=$(tail -n "$no_anchor_tail" "$TRANSCRIPT_PATH" 2>/dev/null)
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
chunk_compact=$(printf '%s\n' "$chunk" | jq -cR 'fromjson? // empty | {
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
Your job: find moments worth logging as learning signals. THREE classes count:

1. "user-correction" — __PERSONA__ tells Claude it did something wrong, should
   have done something else, or expresses frustration about a mistake.
2. "self-correction" — Claude itself notices and fixes its own mistake, or
   admits doing something suboptimal, WITHOUT being told first.
3. "win" — Claude or __PERSONA__ reached a NON-TRIVIAL, REUSABLE solution worth
   keeping for the future: a tool gotcha + its workaround, a working pattern, a
   derived rule. NOT every completed task — only something reusable BEYOND the
   current task.

Output a JSON array. Each item describes one event.

For a mistake (class "user-correction" or "self-correction"):
{
  "class": "user-correction | self-correction",
  "did": "what Claude actually did (1-2 sentences, past tense, in __LANGUAGE__)",
  "wanted": "what should have happened instead (1 sentence, in __LANGUAGE__)",
  "cause_hypothesis": "skill | claude-md | memory | habit | unknown",
  "cause_explanation": "1 short phrase in __LANGUAGE__ explaining the hypothesis",
  "runtime_fix": "self-correction ONLY: what Claude did to recover in the moment (1 phrase in __LANGUAGE__); else null",
  "related_skill_or_file": "name of skill or file if related, else null",
  "turn_uuid": "uuid of the relevant turn"
}

For a win (class "win"):
{
  "class": "win",
  "what": "the solution/pattern Claude arrived at (1-2 sentences, in __LANGUAGE__)",
  "reusable": "why it is valuable / where it can be reused (1 sentence, in __LANGUAGE__)",
  "target": "memory | skill | convention (best guess where to promote it)",
  "related_skill_or_file": "name of skill or file, else null",
  "turn_uuid": "uuid of the relevant turn"
}

Rules:
- Return clear user-corrections, clear self-corrections, AND clear wins.
- DO NOT invent. If there is no clear event of any class, return [].
- DO NOT include nitpicks about formatting, typos, or content nuance.
  Mistakes = behavioral/process (Claude did X, should have done Y).
- NOISE FILTER (critical). Do NOT log a self-correction that is a one-off
  technical slip Claude already fixed in the same turn with NO lasting lesson:
  wrong shell flag, quoting/escaping, syntax error, reserved variable name, a
  race condition, a miscount/redo. These are cause="habit" with a runtime_fix
  and teach nothing reusable — OMIT them. Log a self-correction ONLY when it
  points to a fixable infrastructure gap (cause skill/claude-md/memory) or
  repeats a known pattern. User-corrections: always log.
- Be CONSERVATIVE with wins: only genuinely reusable insight, never routine
  "task completed". When unsure whether something is a win, omit it.
- For wins, also OMIT anything that is general programming common knowledge or
  likely already recorded (a basic tool fact, a one-line gotcha). A win must be
  a non-obvious, reusable pattern. When in doubt, omit.
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
  _st_tmp=$(mktemp "$STATE_DIR/.st.XXXXXX" 2>/dev/null) && \
    jq --arg u "$latest_uuid" --arg t "$now_iso" --arg s "$SID" \
      '.anchors = (.anchors // {}) | .anchors[$s] = $u | .last_run_at = $t' \
      "$STATE_FILE" > "$_st_tmp" 2>/dev/null && mv "$_st_tmp" "$STATE_FILE" || rm -f "$_st_tmp"
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

# --- Format entries and prepend them to the right file(s) ---
# Mistakes (user/self-correction) → day file <YYYY-MM>/<YYYY-MM-DD>.md ("## HH:MM").
# Wins                            → wins/candidates.md buffer            ("## YYYY-MM-DD HH:MM").
session_short="${SID:0:8}"
ts_local=$(date +%H:%M)     # mistake header is HH:MM (date lives in folder/filename)
today=$(date +%Y-%m-%d)
month=$(date +%Y-%m)

DAY_FILE="$LEARNING_LOG_DIR/$month/$today.md"
WINS_FILE="$LEARNING_LOG_DIR/wins/candidates.md"

# --- Content-level dedup by turn_uuid ---
# A turn re-scanned by another session (resumed/forked transcript, tail overlap)
# must not produce a duplicate entry. Match the 8-char turn short already
# embedded in existing Source lines and drop any item already logged.
seen_turns=$(cat "$DAY_FILE" "$WINS_FILE" 2>/dev/null \
  | grep -oE 'turn=[0-9a-fA-F]{6,8}' | sed 's/turn=//' \
  | sort -u | jq -R . | jq -sc . 2>/dev/null)
[ -z "$seen_turns" ] && seen_turns='[]'
response_clean=$(printf '%s' "$response_clean" | jq -c --argjson seen "$seen_turns" \
  '[ .[] | select( ((.turn_uuid // "?")[0:8]) as $t | ($seen | index($t)) | not ) ]' 2>/dev/null)
[ -z "$response_clean" ] && response_clean='[]'

# Prepend $block into $target before the first existing "## " header (newest on
# top), or after the H1 if none. Creates $target with $h1 if missing. Entries
# come from a FILE (never `awk -v`: it interprets backslash escapes and special
# markdown chars silently break it — empty output, a real bug hit in dev).
prepend_block() {
  local target="$1" h1="$2" block="$3" dir tmp entries_tmp
  [ -z "$block" ] && return 1
  dir=$(dirname "$target")
  mkdir -p "$dir" 2>/dev/null || { log_err "failed to mkdir: $dir"; return 1; }
  if [ ! -f "$target" ]; then
    printf '%s\n' "$h1" > "$target" 2>/dev/null || { log_err "failed to create: $target"; return 1; }
  fi
  tmp=$(mktemp "$dir/.ll.XXXXXX" 2>/dev/null) || { log_err "mktemp failed"; return 1; }
  entries_tmp=$(mktemp "$dir/.ent.XXXXXX" 2>/dev/null) || { log_err "mktemp failed"; rm -f "$tmp"; return 1; }
  printf '%s\n' "$block" > "$entries_tmp"
  awk '
    NR==FNR { buf = buf $0 ORS; next }
    /^## / && !inserted { printf "%s", buf; inserted=1 }
    { print }
    END { if (!inserted) { print ""; printf "%s", buf } }
  ' "$entries_tmp" "$target" > "$tmp" 2>/dev/null
  rm -f "$entries_tmp"
  if [ -s "$tmp" ]; then
    mv "$tmp" "$target" 2>/dev/null || { log_err "failed to replace: $target"; rm -f "$tmp"; return 1; }
  else
    log_err "awk produced empty output for $target"; rm -f "$tmp"; return 1
  fi
  return 0
}

# Mistakes → day file.
mistakes_md=$(printf '%s' "$response_clean" | jq -r --arg ts "$ts_local" --arg conv "$session_short" --arg wl "$LL_WIKILINKS" '
  .[] | select(type=="object") | select((.class // "user-correction") != "win") |
  "## " + $ts + "\n" +
  "- **Did:** " + (.did // "—") + "\n" +
  "- **Wanted:** " + (.wanted // "—") + "\n" +
  "- **Cause:** " + (.cause_hypothesis // "unknown") + " — " + (.cause_explanation // "—") + "\n" +
  (if (.runtime_fix // null) != null and (.runtime_fix // "") != ""
   then "- **Runtime-fix:** " + .runtime_fix + "\n" else "" end) +
  "- **Related:** " + (
    if (.related_skill_or_file // null) == null or (.related_skill_or_file // "") == "" then "—"
    elif $wl == "true" then "[[" + .related_skill_or_file + "]]"
    else "`" + .related_skill_or_file + "`"
    end
  ) + "\n" +
  "- **Status:** open\n" +
  "- **Source:** auto (haiku, " + (.class // "user-correction") + ", conv=" + $conv + ", turn=" + (.turn_uuid // "?")[0:8] + ")\n" + "\n"
' 2>/dev/null)

# Wins → candidates buffer (full date in header, single file).
wins_md=$(printf '%s' "$response_clean" | jq -r --arg ts "$today $ts_local" --arg conv "$session_short" '
  .[] | select(type=="object") | select((.class // "") == "win") |
  "## " + $ts + "\n" +
  "- **What:** " + (.what // .did // "—") + "\n" +
  "- **Reusable:** " + (.reusable // "—") + "\n" +
  "- **Target:** " + (.target // "—") + "\n" +
  "- **Status:** open\n" +
  "- **Source:** auto (haiku, win, conv=" + $conv + ", turn=" + (.turn_uuid // "?")[0:8] + ")\n" + "\n"
' 2>/dev/null)

wrote=0
[ -n "$mistakes_md" ] && { prepend_block "$DAY_FILE" "# Learning Log — $today" "$mistakes_md" && wrote=1; }
[ -n "$wins_md" ] && { prepend_block "$WINS_FILE" "# Win Candidates" "$wins_md" && wrote=1; }

[ "$wrote" -eq 0 ] && log_err "no entries written (empty format output for all $entry_count classified items)"

exit 0
