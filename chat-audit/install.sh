#!/usr/bin/env bash
# chat-audit installer — copies the package into a target project's .claude/ and
# registers the nudge hook. Idempotent: safe to re-run (upgrade path).
#
# Installs: the chat-audit skill (router + 7 modes + Node extractors) and the
# UserPromptSubmit nudge hook, and seeds .claude/chat-audit.config.json.
#
# Usage:
#   ./install.sh [target]          # install into <target> (default: current dir)
#   ./install.sh --check [target]  # report installed vs package version
#   ./install.sh --link [target]   # symlink the skill to this clone instead of copying
#
# --link is for machines that keep this repo checked out: the skill becomes a gitignored symlink into payload/,
# so `git pull` in the clone updates every linked project. A copied skill drifts until the next re-install.
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
VERSION_FILE="$CLAUDE_DIR/.chat-audit.version"
CONFIG="$CLAUDE_DIR/chat-audit.config.json"

if [ "$MODE" = "check" ]; then
  # Every read below is guarded. Under `set -e` a bare `[ -f x ] && cmd` whose
  # test is false returns 1 and kills the script, so --check against a project
  # that never installed the package printed nothing instead of "not installed".
  inst=""
  if [ -f "$VERSION_FILE" ]; then
    if command -v jq >/dev/null 2>&1; then
      inst="$(jq -r '.version // ""' "$VERSION_FILE" 2>/dev/null || true)"
    else
      inst="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$VERSION_FILE" || true)"
    fi
  fi
  [ -n "$inst" ] || inst="not installed"
  if [ "$inst" = "$PKG_VERSION" ]; then echo "up-to-date (v$PKG_VERSION)";
  elif [ "$inst" = "not installed" ]; then echo "not installed (package v$PKG_VERSION)";
  else echo "outdated: installed=$inst package=$PKG_VERSION — re-run ./install.sh to upgrade"; fi
  exit 0
fi

# --- Step 0: validate before writing anything ---
command -v node >/dev/null 2>&1 || { echo "ERROR: node is required (the extractors are Node scripts)." >&2; exit 1; }
if command -v jq >/dev/null 2>&1; then MERGE=1; else MERGE=0; echo "WARN: jq not found; will print the settings snippet for manual paste" >&2; fi
if [ "$MERGE" = 1 ] && [ -f "$SETTINGS" ] && ! jq empty "$SETTINGS" 2>/dev/null; then
  echo "ERROR: $SETTINGS is invalid JSON — fix it first; nothing was changed." >&2; exit 1
fi

# --- Step 1: copy payload ---
mkdir -p "$CLAUDE_DIR/hooks" "$CLAUDE_DIR/skills"
SKILL_SRC="$PKG_DIR/payload/skills/chat-audit"
SKILL_DST="$CLAUDE_DIR/skills/chat-audit"

if [ "$LINK" = 1 ]; then
  # Replacing a real directory would silently drop edits made in place. Refuse unless it matches the package.
  if [ -L "$SKILL_DST" ]; then
    rm -f "$SKILL_DST"
  elif [ -d "$SKILL_DST" ]; then
    if [ "$FORCE" = 1 ] || diff -rq "$SKILL_DST" "$SKILL_SRC" >/dev/null 2>&1; then
      rm -rf "$SKILL_DST"
    else
      echo "ERROR: $SKILL_DST differs from the package — linking would discard those edits." >&2
      echo "       Port them into $SKILL_SRC first (then re-run), or pass --force to drop them." >&2
      exit 1
    fi
  fi
  ln -s "$SKILL_SRC" "$SKILL_DST"
elif [ -L "$SKILL_DST" ]; then
  # Already linked: copying would write straight through the symlink into the package.
  echo "kept existing symlink -> $(readlink "$SKILL_DST")" >&2
else
  # Skill + modes + lib are package-managed -> overwrite (customize via config, not by editing).
  mkdir -p "$SKILL_DST/modes" "$SKILL_DST/lib"
  cp "$SKILL_SRC/SKILL.md"   "$SKILL_DST/SKILL.md"
  cp "$SKILL_SRC/modes/"*.md "$SKILL_DST/modes/"
  cp "$SKILL_SRC/lib/"*.mjs  "$SKILL_DST/lib/"
fi
cp "$PKG_DIR/payload/hooks/chat-audit-nudge.sh"    "$CLAUDE_DIR/hooks/"
chmod +x "$CLAUDE_DIR/hooks/chat-audit-nudge.sh"

# Config is yours -> seed only if absent.
if [ -f "$CONFIG" ]; then
  echo "kept existing chat-audit.config.json (your settings preserved)" >&2
else
  cp "$PKG_DIR/config.defaults.json" "$CONFIG"
fi

# --- Step 2: register the hook (idempotent, atomic) ---
NUDGE='bash "$CLAUDE_PROJECT_DIR/.claude/hooks/chat-audit-nudge.sh"'

JQ_MERGE='
  def base(c): (c | capture("(?<f>[^/\\\\\"]+\\.sh)").f) // c;
  def present(arr; c): any((arr // [])[]?.hooks[]?; ((.command // "") | (capture("(?<f>[^/\\\\\"]+\\.sh)").f // .)) == base(c));
  .hooks = (.hooks // {})
  | .hooks.UserPromptSubmit = ((.hooks.UserPromptSubmit // []) as $g
      | if present($g; $nudge) then $g
        else $g + [ {hooks:[{type:"command", command:$nudge, "_cc_ca":true}]} ] end)
'

if [ "$MERGE" = 1 ]; then
  [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
  tmp="$(mktemp "$CLAUDE_DIR/.settings.XXXXXX")"
  if jq --arg nudge "$NUDGE" "$JQ_MERGE" "$SETTINGS" > "$tmp" && jq empty "$tmp" 2>/dev/null; then
    mv "$tmp" "$SETTINGS"
  else
    rm -f "$tmp"; echo "ERROR: settings merge failed; settings.json untouched." >&2; exit 1
  fi
  n=$(jq '[.hooks[]?[]?.hooks[]? | select((.command // "") | test("chat-audit-nudge.sh"))] | length' "$SETTINGS" 2>/dev/null || echo 0)
  [ "$n" -le 1 ] || echo "WARN: chat-audit-nudge.sh registered $n times — check $SETTINGS" >&2
else
  echo "Manual step — add to $SETTINGS:" >&2
  echo "  UserPromptSubmit -> command: $NUDGE" >&2
fi

# --- Step 3: .gitignore (per-machine state) ---
GI="$TARGET/.gitignore"; START="# >>> chat-audit >>>"; END="# <<< chat-audit <<<"
if [ ! -f "$GI" ] || ! grep -qF "$START" "$GI"; then
  printf '\n%s\n.claude/state/chat-audit/\n%s\n' "$START" "$END" >> "$GI"
fi
# --link: the skill is a symlink into this machine's clone, so it never goes into the project's git.
LSTART="# >>> chat-audit --link >>>"
if [ "$LINK" = 1 ] && ! grep -qF "$LSTART" "$GI"; then
  printf '\n%s\n.claude/skills/chat-audit\n%s\n' "$LSTART" "# <<< chat-audit --link <<<" >> "$GI"
fi

# --- Step 4: version stamp ---
if [ "$MERGE" = 1 ]; then
  jq -n --arg v "$PKG_VERSION" --arg t "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{version:$v, installed_at:$t}' > "$VERSION_FILE"
else
  printf '{"version":"%s"}\n' "$PKG_VERSION" > "$VERSION_FILE"
fi

cat >&2 <<SUMMARY

chat-audit v$PKG_VERSION installed into: $CLAUDE_DIR
  skill:  skills/chat-audit/SKILL.md  + modes/ (7) + lib/ (5 Node scripts)
  hook:   chat-audit-nudge.sh  (UserPromptSubmit — routes "re-read the last chats"
                                requests through the skill instead of answering them flat)
  config: chat-audit.config.json   <-- agent model, horizon, report location
  state:  .claude/state/chat-audit/  (ledger + nudge markers; gitignored)
  requires: node · jq (install only)

TRY IT:  node "$CLAUDE_DIR/skills/chat-audit/lib/discover.mjs" sessions --project "$TARGET" --days 14
SUMMARY
