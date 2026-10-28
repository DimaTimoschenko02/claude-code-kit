#!/usr/bin/env bash
# spec-writer installer — puts the spec-writer skill, the spec-builder-check agent and the spec-lint hook into a
# project's .claude/ and registers the hook. Idempotent: re-run to upgrade.
#
# Usage:
#   ./install.sh [target]          # copy into <target> (default: current dir)
#   ./install.sh --link [target]   # symlink the skill and the agent to this clone (gitignored); git pull here updates them
#   ./install.sh --check [target]  # installed vs package version
#
# The project keeps its own facts in .claude/spec-writer.project.md (seeded from the template, never overwritten):
# language, which files are specs, extra sections, and what the spec writer would otherwise guess.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_VERSION="$(cat "$PKG_DIR/VERSION")"

MODE="install"; LINK=0; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE="check"; shift ;;
    --link)  LINK=1; shift ;;
    --force) FORCE=1; shift ;;
    --) shift; break ;;
    -*) echo "unknown flag: $1" >&2; exit 1 ;;
    *) break ;;
  esac
done
TARGET="$(cd "${1:-$PWD}" 2>/dev/null && pwd)" || { echo "target dir not found: ${1:-$PWD}" >&2; exit 1; }
CLAUDE_DIR="$TARGET/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"
VERSION_FILE="$CLAUDE_DIR/.spec-writer.version"
PROJECT_FILE="$CLAUDE_DIR/spec-writer.project.md"

if [ "$MODE" = "check" ]; then
  inst=""
  if [ -f "$VERSION_FILE" ]; then inst="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$VERSION_FILE" || true)"; fi
  if [ -z "$inst" ]; then echo "not installed (package v$PKG_VERSION)"
  elif [ "$inst" = "$PKG_VERSION" ]; then echo "up-to-date (v$PKG_VERSION)"
  else echo "outdated: installed=$inst package=$PKG_VERSION — re-run ./install.sh"; fi
  exit 0
fi

command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required to register the hook" >&2; exit 1; }
if [ -f "$SETTINGS" ] && ! jq empty "$SETTINGS" 2>/dev/null; then
  echo "ERROR: $SETTINGS is invalid JSON — fix it first; nothing was changed." >&2; exit 1
fi
mkdir -p "$CLAUDE_DIR/skills" "$CLAUDE_DIR/agents" "$CLAUDE_DIR/hooks"

# place <src> <dst>: symlink with --link, copy otherwise. A real file or folder that differs from the package is not
# replaced by a link without --force — its local edits would be lost.
place() {
  local src="$1" dst="$2"
  if [ "$LINK" = 1 ]; then
    if [ -L "$dst" ]; then rm -f "$dst"
    elif [ -e "$dst" ]; then
      if [ "$FORCE" = 1 ] || diff -rq "$dst" "$src" >/dev/null 2>&1; then rm -rf "$dst"
      else echo "ERROR: $dst differs from the package — port the edits into $src or pass --force." >&2; exit 1; fi
    fi
    ln -s "$src" "$dst"
  elif [ -L "$dst" ]; then
    echo "kept existing symlink $dst -> $(readlink "$dst")" >&2
  elif [ -d "$src" ]; then
    mkdir -p "$dst"; cp -R "$src/." "$dst/"
  else
    cp "$src" "$dst"
  fi
}
place "$PKG_DIR/payload/skills/spec-writer" "$CLAUDE_DIR/skills/spec-writer"
place "$PKG_DIR/payload/agents/spec-builder-check.md" "$CLAUDE_DIR/agents/spec-builder-check.md"
# The hook is a tracked wrapper that finds the linter through the skill folder: with a link and no kit on the
# machine it finds nothing and stays silent instead of breaking every write.
cp "$PKG_DIR/payload/hooks/spec-lint.sh" "$CLAUDE_DIR/hooks/spec-lint.sh"
chmod +x "$CLAUDE_DIR/hooks/spec-lint.sh"

if [ -f "$PROJECT_FILE" ]; then echo "kept existing spec-writer.project.md" >&2
else cp "$PKG_DIR/payload/skills/spec-writer/project-template.md" "$PROJECT_FILE"
  echo "seeded spec-writer.project.md — fill it in (language, spec_glob, project facts)" >&2; fi

HOOK='bash "$CLAUDE_PROJECT_DIR/.claude/hooks/spec-lint.sh"'
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
tmp="$(mktemp "$CLAUDE_DIR/.settings.XXXXXX")"
if jq --arg h "$HOOK" '
    .hooks = (.hooks // {})
    | .hooks.PostToolUse = ((.hooks.PostToolUse // []) as $g
        | if any($g[]?.hooks[]?; (.command // "") | test("spec-lint\\.sh")) then $g
          else $g + [{matcher: "Write|Edit", hooks: [{type: "command", command: $h}]}] end)
  ' "$SETTINGS" > "$tmp" && jq empty "$tmp" 2>/dev/null; then mv "$tmp" "$SETTINGS"
else rm -f "$tmp"; echo "ERROR: settings merge failed; settings.json untouched." >&2; exit 1; fi

GI="$TARGET/.gitignore"; LSTART="# >>> spec-writer --link >>>"
if [ "$LINK" = 1 ] && { [ ! -f "$GI" ] || ! grep -qF "$LSTART" "$GI"; }; then
  printf '\n%s\n.claude/skills/spec-writer\n.claude/agents/spec-builder-check.md\n%s\n' "$LSTART" "# <<< spec-writer --link <<<" >> "$GI"
fi

printf '{"version":"%s","installed_at":"%s","link":%s}\n' "$PKG_VERSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$( [ "$LINK" = 1 ] && echo true || echo false )" > "$VERSION_FILE"

cat >&2 <<SUMMARY

spec-writer v$PKG_VERSION installed into $CLAUDE_DIR ($( [ "$LINK" = 1 ] && echo "linked to $PKG_DIR, gitignored" || echo copied ))
  skill:  skills/spec-writer/            write a spec before code goes to another executor
  agent:  agents/spec-builder-check.md   reads the spec as the coder would, lists what it would have to guess
  hook:   hooks/spec-lint.sh             PostToolUse Write|Edit — blocks a spec file that breaks the contract
  config: spec-writer.project.md         language, spec_glob, extra_sections + this project's facts — EDIT IT
  needs:  node (hook), jq (install)
SUMMARY
