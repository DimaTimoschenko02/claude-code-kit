#!/bin/bash
# PreToolUse guard for the secrets-redact mod, wired as a classic hook (matcher "*") outside the mod engine.
# A mod that fails to load is skipped with a line in the debug log only, and nothing else hides secret values any
# more, so a dead mod would pass every value to the model unseen. The mod writes
# ~/.claude/state/secrets-redact/alive/<session_id> at session start and at every prompt; a session without that file
# gets every tool call denied, loudly. Escape hatch for the owner: touch ~/.claude/state/secrets-redact/guard-off
#
# Settings hooks reload in running sessions, the mod list does not: a Claude process that started before the mod was
# switched on could not load it, so it is let through (it gets the mod when restarted). `enabled-at` marks that
# moment; with none, the first run of this guard is taken as it, so wiring the guard never locks open sessions.
dir="$HOME/.claude/state/secrets-redact"
input=$(cat)
[[ $input =~ \"session_id\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] || exit 0
sid=${BASH_REMATCH[1]}
[[ -f "$dir/alive/$sid" || -f "$dir/guard-off" ]] && exit 0
[[ -f "$dir/enabled-at" ]] || { mkdir -p "$dir" && touch "$dir/enabled-at"; exit 0; }

# the Claude process this hook runs for: the first ancestor that is not a shell
p=$PPID
for _ in 1 2 3 4; do
  c=$(ps -o comm= -p "$p" 2>/dev/null) || break
  case "${c##*/}" in sh|bash|zsh|dash|-sh|-bash|-zsh) p=$(ps -o ppid= -p "$p" | tr -d ' ') ;; *) break ;; esac
done
e=$(LC_ALL=C ps -o etime= -p "$p" 2>/dev/null | tr -d ' ')
if [[ -n $e ]]; then
  d=0; [[ $e == *-* ]] && { d=${e%%-*}; e=${e#*-}; }
  IFS=: read -r a b c <<<"$e"
  if [[ -z $c ]]; then h=0; m=$a; s=$b; else h=$a; m=$b; s=$c; fi
  started=$(( $(date +%s) - (10#$d * 86400 + 10#$h * 3600 + 10#$m * 60 + 10#$s) ))
  enabled=$(stat -f %m "$dir/enabled-at" 2>/dev/null || stat -c %Y "$dir/enabled-at")
  (( started < enabled )) && exit 0
fi
(( RANDOM % 500 == 0 )) && find "$dir/alive" -type f -mtime +7 -delete 2>/dev/null
msg="secrets-redact mod is not running in this session (no heartbeat for $sid): tool output would reach the model with secret values unhidden, so every tool call is denied. Likely a Claude Code update broke the mod: run 'claude --debug' and look for secrets-redact, or 'claude plugin test ~/claude-code-kit/mods/secrets-redact'. To work without it: touch $dir/guard-off"
printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$msg" "$msg"
