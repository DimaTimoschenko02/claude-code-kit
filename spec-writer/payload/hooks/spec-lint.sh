#!/usr/bin/env bash
# spec-lint hook — PostToolUse(Write|Edit): after a spec file is written, check it against the spec-writer contract and
# hand the errors back to the model (decision: block) so it fixes them before the spec reaches a coder.
# Which files are specs, and in which language, comes from the project's .claude/spec-writer.project.md; without that
# file, or for any other path, the hook is silent. Any failure → silent: a broken linter must not stop a write.
command -v node >/dev/null 2>&1 || exit 0
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$here/../skills/spec-writer/scripts/spec-lint.mjs" --hook 2>/dev/null
exit 0
