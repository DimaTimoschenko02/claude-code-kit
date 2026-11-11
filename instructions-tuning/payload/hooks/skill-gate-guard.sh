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
# invocation on every tool call. /compact summarizes the conversation, so a
# pre-compact invocation counts only if Claude Code re-attached the skill whole
# after that compaction (see `restored` below).
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

# Every field in one jq start: on Windows each fork costs 0.3–0.9 s under load, and a jq per field made this gate
# 14–31 s a call (measured 01.11). @sh quotes each value for eval, newlines in a command included.
eval "$(printf '%s' "$input" | jq -r '@sh "transcript=\(.transcript_path // "") cwd=\(.cwd // "") tool=\(.tool_name // "")
  file_path=\(.tool_input.file_path // "") command=\(.tool_input.command // "") aid_early=\(.agent_id // "")
  own_early=\(.agent_transcript_path // "") sid_early=\(.session_id // "") atype=\(.agent_type // "")"' 2>/dev/null)" \
  2>/dev/null || exit 0
aid="$aid_early" sid="$sid_early"

ROOT="${CLAUDE_PROJECT_DIR:-$cwd}"
[ -z "$ROOT" ] && ROOT="$(pwd)"
# Windows (Git Bash): payload paths arrive as `C:\...`, the root as `C:\...`, `C:/...` or `/c/...`.
# One spelling for all of them, or the prefix cut below never matches and every edit passes ungated.
# `-m` (C:/...) keeps the paths usable by native python/node as well as by bash tests. A drive path is respelled in bash
# (the same `C:/...` cygpath -m gives, no fork); anything else still goes through cygpath.
HAS_CYGPATH=""; command -v cygpath >/dev/null 2>&1 && HAS_CYGPATH=1
win_var() {   # respell the variable named $1 in place
  local p="${!1}"
  [ -z "$HAS_CYGPATH" ] || [ -z "$p" ] && return 0
  p="${p//\\//}"
  if [[ "$p" =~ ^([A-Za-z]):(/|$) ]]; then p="${BASH_REMATCH[1]^^}${p:1}"
  elif [[ "$p" =~ ^/([A-Za-z])(/|$) ]]; then p="${BASH_REMATCH[1]^^}:/${p:3}"
  else p=$(cygpath -m "${!1}"); fi
  printf -v "$1" '%s' "$p"
}
win_var ROOT; win_var cwd; win_var transcript

CONFIG="$ROOT/.claude/skill-gate.config.json"
[ -f "$CONFIG" ] || exit 0   # no gates configured -> fail-open

if [ "$tool" = "Bash" ]; then
  targets=""
  [ -n "$command" ] && targets=$(printf '%s\n' "$command" \
    | python3 -B "$LIB/bash-write-targets.py" "${cwd:-$ROOT}" 2>/dev/null)
else
  targets="$file_path"
fi
[ -z "$targets" ] && exit 0

# Which skill owns a path? First matching gate wins (prefix or exact).
# Bind fields to vars BEFORE the `$rel | ...` pipe — inside startswith(), `.`
# is $rel (a string), so `.path_prefix` there would index the string and error.
# A gate path written from `~/` means the same file on every machine: it resolves against $HOME.
home_w="${HOME:-}"; win_var home_w
owner() {
  jq -r --arg rel "$1" --arg home "$home_w" '
    def fromhome: if . != null and startswith("~/") then $home + ltrimstr("~") else . end;
    .gates[]?
    | (.path_prefix // null | fromhome) as $p
    | (.path_exact // null | fromhome) as $e
    | select( ($p != null and ($rel | startswith($p))) or ($e != null and ($rel == $e)) )
    | .skill' "$CONFIG" 2>/dev/null | head -1
}
gated=""   # "skill<TAB>path" per governed target
while IFS= read -r fp; do
  [ -z "$fp" ] && continue
  win_var fp
  r="${fp#"$ROOT"/}"
  # A Claude Code worktree (`.claude/worktrees/<name>/`) is another checkout of the same repo: its `apps/x.ts` is
  # governed like the root's. Without this cut the path keeps the worktree prefix, no gate matches, and the edit
  # passes ungated.
  r="${r#*.claude/worktrees/*/}"
  s=$(owner "$r")
  [ -n "$s" ] && gated+="$s"$'\t'"$r"$'\n'
done <<< "$targets"
[ -z "$gated" ] && exit 0   # no governed path written
hook_log pass

LOG="$ROOT/.claude/state/skill-invocations.jsonl"
[ -f "$LOG" ] || exit 0   # logger hasn't written yet -> fail-open

# Whose context is this? Inside a subagent `transcript_path` is the PARENT's transcript: the parent's compaction does
# not touch the subagent's context, yet the gate read it as a reset and re-locked a coder that had loaded the skill
# minutes earlier (41 of 51 coder blocks, 09–23.10). A subagent's own transcript is
# <project-dir>/<session_id>/subagents/**/agent-<agent_id>.jsonl; its own compactions and skill re-attachments are there.
# Not found -> fail-open, logged, never the parent's file.
if [ -n "$aid_early" ]; then
  own="$own_early"
  if [ -z "$own" ] || [ ! -f "$own" ]; then
    own=""
    case "$transcript" in
      */subagents/*agent-"$aid_early".jsonl) own="$transcript" ;;
      ?*)
        proj_dir="${transcript%/*}"
        case "$transcript" in */subagents/*) proj_dir="${transcript%%/subagents/*}"; proj_dir="${proj_dir%/*}" ;; esac
        [ -n "$sid_early" ] && [ -d "$proj_dir/$sid_early/subagents" ] && \
          own=$(find "$proj_dir/$sid_early/subagents" -name "agent-$aid_early.jsonl" 2>/dev/null | head -1) ;;
    esac
  fi
  if [ -z "$own" ] || [ ! -f "$own" ]; then
    hook_log skip "no subagent transcript"
    exit 0
  fi
  transcript="$own"
fi

# Context-reset boundary = later of (session start, last /compact). Compaction is
# recorded as a type:user entry with isCompactSummary:true; otherwise the earliest
# transcript timestamp is the session start.
#
# After a compaction Claude Code re-attaches the text of every skill invoked in the session (attachment
# `invoked_skills`, each cut at 20 000 chars). A skill re-attached whole is still in context, so that compaction did not
# reset it — denying it only made the session re-load the skill and resend the write (31 bounces in 4 sessions,
# 06–11.10). Only the attachment that follows the last compact summary in file order counts (both carry the same
# second). A subagent's own compaction re-attaches its skills in its own file, which `transcript` points at by now.
#
# Both come from one grep over the transcript and one jq over its hits (it was three grep pipelines and two jq: ten
# process starts, 0.3–0.9 s each on Windows).
boundary="" restored=""   # restored: one skill name per line, as invoked ("pricehub:code-style" or "code-style")
if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  eval "$(grep -n -e 'isCompactSummary' -e '"type":"invoked_skills"' "$transcript" 2>/dev/null | jq -rRn '
    reduce (inputs | capture("^(?<n>[0-9]+):(?<l>.*)$")) as $h ({b: null, c: 0, s: 0, sl: null};
      ($h.n | tonumber) as $n
      | if ($h.l | contains("\"isCompactSummary\":true")) then .c = $n else . end
      | if ($h.l | contains("isCompactSummary")) then
          (($h.l | fromjson?) // {}) as $e | if $e.isCompactSummary == true and $e.timestamp != null then .b = $e.timestamp else . end
        else . end
      | if ($h.l | contains("\"type\":\"invoked_skills\"")) then .s = $n | .sl = $h.l else . end)
    | (if .c > 0 and .s > .c then
         [(.sl | fromjson? // {}) | .attachment.skills[]? | select((.content // "" | length) < 20000) | .name | tostring] | join("\n")
       else "" end) as $r
    | @sh "boundary=\(.b // "" | tostring) restored=\($r)"' 2>/dev/null)" 2>/dev/null
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


# A subagent whose definition lists the skill under `skills:` got the skill's full text injected at its start, and that
# load is no Skill tool call, so the log never shows it. The coder was told in prose to load code-style itself and was
# bounced 49 times on 30 runs; with the skill preloaded the gate must count the preload. The definition is found by
# its `name:` (hooks receive it as agent_type), project agents first, then the user's.
# The native Codex bridge sets CODEX_COMPAT=1: it logs verified full skill reads but does not inject `skills:`.
# In that mode only the invocation log below proves a load; the Claude definition is not evidence.
preloaded=""
if [ "${CODEX_COMPAT:-}" != "1" ] && [ -n "$aid_early" ] && [ -n "$atype" ]; then
  preloaded=$(python3 -B - "$atype" "$ROOT/.claude/agents" "$HOME/.claude/agents" <<'PY' 2>/dev/null
import glob, os, re, sys
name, dirs = sys.argv[1], sys.argv[2:]
for d in dirs:
    for path in sorted(glob.glob(os.path.join(d, "*.md"))):
        text = open(path, encoding="utf-8", errors="replace").read()
        m = re.match(r"---\n(.*?)\n---", text, re.S)
        if not m or not re.search(r"(?m)^name:\s*['\"]?" + re.escape(name) + r"['\"]?\s*$", m.group(1)):
            continue
        out, inlist = [], False
        for line in m.group(1).split("\n"):
            if inlist:
                item = re.match(r"\s+-\s*['\"]?([^'\"#]+?)['\"]?\s*$", line)
                if item:
                    out.append(item.group(1)); continue
                inlist = False
            head = re.match(r"skills:\s*(.*)$", line)
            if head:
                rest = head.group(1).strip().strip("[]")
                if rest:
                    out += [s.strip().strip("'\"") for s in rest.split(",") if s.strip()]
                else:
                    inlist = True
        print("\n".join(out))
        sys.exit(0)
PY
)
fi

# Most recent invocation ts of the required skill (ISO8601 UTC -> lexicographic compare valid).
# Directory-scoped skills are logged with a scope prefix ("myrepo:vault-write"), so accept "<scope>:<skill>" too.
# Only this session's invocations count: parallel sessions share the log, and another window's /skill must not open
# this one's gate. A record without session_id (logged before the field existed) still counts — fail-open, as above.
# Same for agents: a subagent shares the parent's session_id but not the parent's context, so the parent's
# invocation must not open a subagent's gate, nor the reverse. No agent_id = the main thread.
req="" rel=""
while IFS=$'\t' read -r s r; do
  [ -z "$s" ] && continue
  if [ -n "$restored" ] && printf '%s\n' "$restored" | grep -qxE "([^:]+:)?${s}"; then
    continue   # re-attached whole after the last compaction, under either name
  fi
  if [ -n "$preloaded" ] && printf '%s\n' "$preloaded" | grep -qxE "([^:]+:)?${s}"; then
    continue   # preloaded into this subagent by its definition's skills:
  fi
  invoked=$(jq -r --arg s "$s" --arg sid "$sid" --arg aid "$aid" \
    'select(.skill==$s or (.skill|endswith(":"+$s))) | select($sid == "" or (.session_id // "") == "" or .session_id == $sid)
     | select((.agent_id // "") == $aid) | .ts' \
    "$LOG" 2>/dev/null | tail -1)
  if [ -n "$invoked" ] && { [[ "$invoked" > "$boundary" ]] || [ "$invoked" = "$boundary" ]; }; then
    continue
  fi
  req="$s" rel="$r"
  break
done <<< "$gated"
[ -z "$req" ] && exit 0   # every governed target's owner skill is loaded

hook_log deny "$req"
# The deny names the exact call and the bare name: agents reached for "<dir>:${req}", which the Skill tool rejects
# as unknown until Claude Code has discovered that directory's skills, and then loaded the skill twice under both names.
cat >&2 <<EOF
🚧 skill-gate: "${rel}" belongs to skill ${req}, not loaded since the last context reset (session start or /compact).
Next call: Skill with skill: "${req}" — exactly this bare name, no "<dir>:" prefix. Then repeat this same call unchanged.
EOF
exit 2
