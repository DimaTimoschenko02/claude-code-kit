#!/usr/bin/env bash
# SessionStart(compact) hook — nudge to review persistent memory after the context is compacted.
# Wire it under hooks.SessionStart with matcher "compact" in settings.json.
cat <<'EOF'
[memory-checkpoint] The context was just compacted. Skim the segment of work that scrolled off:
did any of these triggers occur — a resolved blocker/bug, a discovery (one that contradicts or
extends what you wrote to memory), a correction of an earlier wrong assumption, a finished
migration step, a new durable fact about the project/infra/user? If so, update your memory files
NOW, before continuing; edit existing entries instead of spawning duplicates. If nothing of the
sort happened, just carry on.
EOF
