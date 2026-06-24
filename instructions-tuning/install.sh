#!/usr/bin/env bash
# instructions-tuning installer — copies the package into a target project's
# .claude/ and registers the hooks. Idempotent: safe to re-run (upgrade path).
#
# Installs: the instructions-tuning skill + the skill-gate determinism hook
# (skill-gate-guard.sh) + its logger (skill-invocation-log.sh), and seeds a
# .claude/skill-gate.config.json you customize with this project's path->skill gates.
#
# Usage:
#   ./install.sh [target]          # install into <target> (default: current dir)
#   ./install.sh --check [target]  # report installed vs package version
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_VERSION="$(cat "$PKG_DIR/VERSION")"

# --- Parse args ---
MODE="install"
if [ "${1:-}" = "--check" ]; then MODE="check"; shift; fi
TARGET="$(cd "${1:-$PWD}" 2>/dev/null && pwd)" || { echo "target dir not found: ${1:-$PWD}" >&2; exit 1; }
CLAUDE_DIR="$TARGET/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"
VERSION_FILE="$CLAUDE_DIR/.instructions-tuning.version"
CONFIG="$CLAUDE_DIR/skill-gate.config.json"

# --- --check mode ---
if [ "$MODE" = "check" ]; then
  if [ -f "$VERSION_FILE" ] && command -v jq >/dev/null 2>&1; then
    inst="$(jq -r '.version // "?"' "$VERSION_FILE" 2>/dev/null)"
  else
    inst="$( [ -f "$VERSION_FILE" ] && sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$VERSION_FILE" )"
    [ -z "$inst" ] && inst="not installed"
  fi
  if [ "$inst" = "$PKG_VERSION" ]; then echo "up-to-date (v$PKG_VERSION)";
  elif [ "$inst" = "not installed" ]; then echo "not installed (package v$PKG_VERSION)";
  else echo "outdated: installed=$inst package=$PKG_VERSION — re-run ./install.sh to upgrade"; fi
  exit 0
fi

# --- Step 0: validate FIRST, before any write ---
if command -v jq >/dev/null 2>&1; then MERGE=1; else MERGE=0; echo "WARN: jq not found; will print the settings snippet for manual paste" >&2; fi
if [ "$MERGE" = 1 ] && [ -f "$SETTINGS" ] && ! jq empty "$SETTINGS" 2>/dev/null; then
  echo "ERROR: $SETTINGS is invalid JSON — fix it first; nothing was changed." >&2; exit 1
fi

# --- Step 1: copy payload ---
mkdir -p "$CLAUDE_DIR/hooks" "$CLAUDE_DIR/skills/instructions-tuning"

# skill-gate-guard.sh is the engine -> always overwrite (carries upgrades).
cp "$PKG_DIR/payload/hooks/skill-gate-guard.sh" "$CLAUDE_DIR/hooks/"
# skill-invocation-log.sh is shared with cc-learning-log -> keep an existing copy
# (both emit identical jsonl; learning-log's may be the richer _lib-based one).
dest_log="$CLAUDE_DIR/hooks/skill-invocation-log.sh"
if [ -f "$dest_log" ]; then
  echo "kept existing skill-invocation-log.sh (shared logger; not overwritten)" >&2
else
  cp "$PKG_DIR/payload/hooks/skill-invocation-log.sh" "$dest_log"
fi
chmod +x "$CLAUDE_DIR"/hooks/skill-gate-guard.sh "$dest_log"

# The skill is package-managed -> overwrite (customize behavior via project
# CLAUDE.md / .claude/rules, not by editing the installed SKILL.md).
cp "$PKG_DIR/payload/skills/instructions-tuning/SKILL.md" "$CLAUDE_DIR/skills/instructions-tuning/SKILL.md"

# Seed gates config only if absent (preserve your path->skill map on re-install).
if [ -f "$CONFIG" ]; then
  echo "kept existing skill-gate.config.json (your gates preserved)" >&2
else
  cp "$PKG_DIR/config.defaults.json" "$CONFIG"
  echo "seeded skill-gate.config.json with default gates — EDIT it to add this project's paths" >&2
fi

# --- Step 2: register hooks in settings.json (idempotent, atomic) ---
GUARD='bash "$CLAUDE_PROJECT_DIR/.claude/hooks/skill-gate-guard.sh"'
SKILLLOG='bash "$CLAUDE_PROJECT_DIR/.claude/hooks/skill-invocation-log.sh"'

JQ_MERGE='
  def base(c): (c | capture("(?<f>[^/\\\\\"]+\\.sh)").f) // c;
  def present(arr; c): any((arr // [])[]?.hooks[]?; ((.command // "") | (capture("(?<f>[^/\\\\\"]+\\.sh)").f // .)) == base(c));
  .hooks = (.hooks // {})
  | .hooks.PreToolUse = ((.hooks.PreToolUse // []) as $g
      | if present($g; $guard) then $g
        else $g + [ {matcher:"Write|Edit", hooks:[{type:"command", command:$guard, "_cc_it":true}]} ] end)
  | .hooks.PostToolUse = ((.hooks.PostToolUse // []) as $g
      | if present($g; $skilllog) then $g
        else $g + [ {matcher:"Skill", hooks:[{type:"command", command:$skilllog, "_cc_it":true}]} ] end)
'

if [ "$MERGE" = 1 ]; then
  [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
  tmp="$(mktemp "$CLAUDE_DIR/.settings.XXXXXX")"
  if jq --arg guard "$GUARD" --arg skilllog "$SKILLLOG" "$JQ_MERGE" "$SETTINGS" > "$tmp" && jq empty "$tmp" 2>/dev/null; then
    mv "$tmp" "$SETTINGS"
  else
    rm -f "$tmp"; echo "ERROR: settings merge failed; settings.json untouched." >&2; exit 1
  fi
  for f in skill-gate-guard.sh skill-invocation-log.sh; do
    n=$(jq "[.hooks[]?[]?.hooks[]? | select((.command // \"\") | test(\"$f\"))] | length" "$SETTINGS" 2>/dev/null || echo 0)
    [ "$n" -le 2 ] || echo "WARN: $f registered $n times — check $SETTINGS" >&2
  done
else
  echo "Manual step — add to $SETTINGS:" >&2
  echo "  PreToolUse  matcher 'Write|Edit' -> command: $GUARD" >&2
  echo "  PostToolUse matcher 'Skill'      -> command: $SKILLLOG" >&2
fi

# --- Step 3: .gitignore (per-machine state) ---
GI="$TARGET/.gitignore"; START="# >>> instructions-tuning >>>"; END="# <<< instructions-tuning <<<"
if [ ! -f "$GI" ] || ! grep -qF "$START" "$GI"; then
  printf '\n%s\n.claude/state/\n%s\n' "$START" "$END" >> "$GI"
fi

# --- Step 4: version stamp ---
if [ "$MERGE" = 1 ]; then
  jq -n --arg v "$PKG_VERSION" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{version:$v, installed_at:$t}' > "$VERSION_FILE"
else
  printf '{"version":"%s"}\n' "$PKG_VERSION" > "$VERSION_FILE"
fi

cat >&2 <<SUMMARY

instructions-tuning v$PKG_VERSION installed into: $CLAUDE_DIR
  skill:   skills/instructions-tuning/SKILL.md   (trigger: editing any instruction/meta file)
  hooks:   skill-gate-guard.sh   (PreToolUse Write|Edit — blocks edits to governed paths
                                   until the owner skill was invoked this context window)
           skill-invocation-log.sh (PostToolUse Skill — records invocations; shared w/ cc-learning-log)
  gates:   skill-gate.config.json   <-- EDIT THIS: map this project's paths -> required skill
  state:   .claude/state/skill-invocations.jsonl   (per-machine, gitignored)
  requires: jq

NEXT: open .claude/skill-gate.config.json and add your project's gates, e.g.
  { "path_prefix": "docs/specs/", "skill": "instructions-tuning" }
  { "path_prefix": "tasks/",      "skill": "task" }
SUMMARY
