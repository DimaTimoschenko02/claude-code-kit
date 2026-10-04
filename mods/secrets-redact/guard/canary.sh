#!/bin/bash
# SessionStart canary for the secrets-redact mod: the mod API changes between Claude Code builds, and a hook whose
# event was renamed loads fine yet never fires, which the heartbeat in alive.sh cannot see. Once per installed
# version this runs the mod's own tests against the new build; a failure is shown to the owner at every start until
# a later build passes.
mod="$(cd "$(dirname "$0")/.." && pwd)"
state="$HOME/.claude/state/secrets-redact"
ver=$(readlink "$HOME/.local/bin/claude" 2>/dev/null); ver=${ver##*/}
[[ -n $ver && $(cat "$state/tested-version" 2>/dev/null) == "$ver" ]] && exit 0
mkdir -p "$state"
# macOS has no timeout(1) unless coreutils is installed; perl's alarm is everywhere
if out=$(cd "$mod" && perl -e 'alarm 120; exec @ARGV' claude plugin test . 2>&1); then
  printf '%s\n' "$ver" > "$state/tested-version"
  exit 0
fi
fails=$(printf '%s\n' "$out" | grep -E '^\(fail\)| fail$' | head -5 | tr '\n' ' ' | tr -d '"\\')
msg="secrets-redact: its tests FAIL on Claude Code ${ver:-unknown} - secret values may reach the model. ${fails}Run: cd $mod && claude plugin test ."
printf '{"systemMessage":"%s"}\n' "$msg"
