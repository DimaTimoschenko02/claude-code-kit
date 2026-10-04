#!/bin/bash
# PreToolUse guard for the secrets-redact mod, wired as a classic hook (matcher "*") outside the mod engine.
# A mod that fails to load is skipped with a line in the debug log only, and nothing else hides secret values any
# more, so a dead mod would pass every value to the model unseen. The mod writes
# ~/.claude/state/secrets-redact/alive/<session_id> at session start and at every prompt; a session without that file
# gets every tool call denied, loudly. Escape hatch for the owner: touch ~/.claude/state/secrets-redact/guard-off
dir="$HOME/.claude/state/secrets-redact"
input=$(cat)
[[ $input =~ \"session_id\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]] || exit 0
sid=${BASH_REMATCH[1]}
[[ -f "$dir/alive/$sid" || -f "$dir/guard-off" ]] && exit 0
(( RANDOM % 500 == 0 )) && find "$dir/alive" -type f -mtime +7 -delete 2>/dev/null
msg="secrets-redact mod is not running in this session (no heartbeat for $sid): tool output would reach the model with secret values unhidden, so every tool call is denied. Likely a Claude Code update broke the mod: run 'claude --debug' and look for secrets-redact, or 'claude plugin test ~/claude-code-kit/mods/secrets-redact'. To work without it: touch $dir/guard-off"
printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$msg" "$msg"
