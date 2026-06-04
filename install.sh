#!/usr/bin/env bash
# cc-learning-log installer — copies the package into a target project's .claude/
# and registers the hooks. Idempotent: safe to re-run (upgrade path).
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
VERSION_FILE="$CLAUDE_DIR/.cc-learning-log.version"

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
command -v claude >/dev/null 2>&1 || echo "NOTE: 'claude' CLI not on PATH; the classifier no-ops until it's installed and logged into a Max/Pro plan." >&2

# --- Step 1: copy payload (overwrite code, preserve user data) ---
mkdir -p "$CLAUDE_DIR/hooks/_lib" "$CLAUDE_DIR/skills/learning-log"
cp "$PKG_DIR"/payload/hooks/_lib/*.sh "$CLAUDE_DIR/hooks/_lib/"
cp "$PKG_DIR"/payload/hooks/*.sh      "$CLAUDE_DIR/hooks/"
chmod +x "$CLAUDE_DIR"/hooks/*.sh

dest="$CLAUDE_DIR/skills/learning-log/SKILL.md"
marker="cc-learning-log:managed"
if [ -f "$dest" ] && ! grep -q "$marker" "$dest"; then
  cp "$dest" "$dest.bak.$(date +%s)"; echo "backed up foreign SKILL.md -> $dest.bak.*" >&2
fi
cp "$PKG_DIR/payload/skills/learning-log/SKILL.md" "$dest"

# Seed config only if absent (preserve user edits on re-install).
[ -f "$CLAUDE_DIR/learning-log.config.json" ] || cp "$PKG_DIR/config.defaults.json" "$CLAUDE_DIR/learning-log.config.json"

# --- Step 2: register hooks in settings.json (idempotent, atomic) ---
# Use bash "<path>" form so Windows/Git-Bash honors it and the +x bit is moot.
TRIGGER='bash "$CLAUDE_PROJECT_DIR/.claude/hooks/learning-log-trigger.sh"'
SKILLLOG='bash "$CLAUDE_PROJECT_DIR/.claude/hooks/skill-invocation-log.sh"'

JQ_MERGE='
  def base(c): (c | capture("(?<f>[^/\\\\\"]+\\.sh)").f) // c;
  def present(arr; c): any((arr // [])[]?.hooks[]?; ((.command // "") | (capture("(?<f>[^/\\\\\"]+\\.sh)").f // .)) == base(c));
  def ensure(ev; c):
    .hooks[ev] = ((.hooks[ev] // []) as $g
      | if present($g; c) then $g
        else $g + [ {hooks:[{type:"command", command:c}], "_cc_ll":true} ] end);
  .hooks = (.hooks // {})
  | .hooks.PostToolUse = ((.hooks.PostToolUse // []) as $g
      | if present($g; $skill) then $g
        else $g + [ {matcher:"Skill", hooks:[{type:"command", command:$skill, "_cc_ll":true}]} ] end)
  | ensure("Stop"; $trig)
  | ensure("SessionEnd"; $trig)
'

if [ "$MERGE" = 1 ]; then
  [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
  tmp="$(mktemp "$CLAUDE_DIR/.settings.XXXXXX")"
  if jq --arg trig "$TRIGGER" --arg skill "$SKILLLOG" "$JQ_MERGE" "$SETTINGS" > "$tmp" && jq empty "$tmp" 2>/dev/null; then
    mv "$tmp" "$SETTINGS"
  else
    rm -f "$tmp"; echo "ERROR: settings merge failed; settings.json untouched." >&2; exit 1
  fi
  # Post-merge dup check (basename appears at most twice: our entry + a possible pre-existing one).
  for f in learning-log-trigger.sh skill-invocation-log.sh; do
    n=$(jq "[.hooks[]?[]?.hooks[]? | select((.command // \"\") | test(\"$f\"))] | length" "$SETTINGS" 2>/dev/null || echo 0)
    [ "$n" -le 2 ] || echo "WARN: $f registered $n times — check $SETTINGS" >&2
  done
  if [ -f "$CLAUDE_DIR/settings.local.json" ] && grep -q learning-log-trigger "$CLAUDE_DIR/settings.local.json" 2>/dev/null; then
    echo "WARN: learning-log hooks also present in settings.local.json — may double-fire." >&2
  fi
else
  echo "Manual step — add to $SETTINGS:" >&2
  echo "  Stop & SessionEnd -> command: $TRIGGER" >&2
  echo "  PostToolUse matcher 'Skill' -> command: $SKILLLOG" >&2
fi

# --- Step 3+4: .gitignore (state always; logs by default for privacy) ---
GI="$TARGET/.gitignore"; START="# >>> cc-learning-log >>>"; END="# <<< cc-learning-log <<<"
if [ ! -f "$GI" ] || ! grep -qF "$START" "$GI"; then
  printf '\n%s\n.claude/state/\n.claude/learning-log/\n%s\n' "$START" "$END" >> "$GI"
fi

# --- Step 5: version stamp ---
if [ "$MERGE" = 1 ]; then
  jq -n --arg v "$PKG_VERSION" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{version:$v, installed_at:$t}' > "$VERSION_FILE"
else
  printf '{"version":"%s"}\n' "$PKG_VERSION" > "$VERSION_FILE"
fi

cat >&2 <<SUMMARY

cc-learning-log v$PKG_VERSION installed into: $CLAUDE_DIR
  hooks:   learning-log-trigger.sh, learning-log-analyze.sh, skill-invocation-log.sh (+ _lib/)
  skill:   skills/learning-log/SKILL.md   (commands: /log, /learning-log, analyze, flush)
  config:  learning-log.config.json       (edit threshold/model/persona/language/wikilinks)
  logs:    .claude/learning-log/<YYYY-MM>/<YYYY-MM-DD>.md   (GITIGNORED by default)
  state:   .claude/state/                 (per-machine, gitignored)
  runtime requires: jq + 'claude' CLI logged into a Max/Pro plan

NOTE: learning-log/ is gitignored by default — entries quote your conversations.
  To version your learning history (private/solo repos): remove '.claude/learning-log/' from .gitignore.
SUMMARY
