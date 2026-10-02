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
#   ./install.sh --link [target]   # symlink the skill to this clone instead of copying
#
# --link is for machines that keep this repo checked out: the installed skill
# becomes a gitignored symlink into payload/ and the gate a tracked shim that runs
# payload/hooks/skill-gate-guard.sh, so `git pull` in the clone updates every linked
# project and a field edit to the skill is an edit to the repo. Without it the skill
# and the gate are copied and drift from the package until the next re-install.
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_VERSION="$(cat "$PKG_DIR/VERSION")"

# --- Parse args ---
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
VERSION_FILE="$CLAUDE_DIR/.instructions-tuning.version"
CONFIG="$CLAUDE_DIR/skill-gate.config.json"

# --- --check mode ---
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

# --- Step 0: validate FIRST, before any write ---
if command -v jq >/dev/null 2>&1; then MERGE=1; else MERGE=0; echo "WARN: jq not found; will print the settings snippet for manual paste" >&2; fi
if [ "$MERGE" = 1 ] && [ -f "$SETTINGS" ] && ! jq empty "$SETTINGS" 2>/dev/null; then
  echo "ERROR: $SETTINGS is invalid JSON — fix it first; nothing was changed." >&2; exit 1
fi

# --- Step 1: copy payload ---
mkdir -p "$CLAUDE_DIR/hooks" "$CLAUDE_DIR/skills"

if [ "$LINK" = 1 ]; then
  # --link: the project keeps a tracked shim and the gate runs from this clone, so `git pull` here updates every
  # linked project. A clone of the project on a machine without the kit gets no gate instead of a broken hook.
  cat > "$CLAUDE_DIR/hooks/skill-gate-guard.sh" <<SHIM
#!/usr/bin/env bash
# skill-gate shim (instructions-tuning install.sh --link): the gate runs from the claude-code-kit clone, so
# \`git pull\` there updates it here. No clone on this machine -> no gate, fail-open like the gate itself.
GATE="$PKG_DIR/payload/hooks/skill-gate-guard.sh"
[ -f "\$GATE" ] || exit 0
log="\$(dirname "\${BASH_SOURCE[0]}")/_lib/hook-log.sh"
[ -f "\$log" ] && export SKILL_GATE_LOG="\$log"
exec bash "\$GATE"
SHIM
else
  # skill-gate-guard.sh is the engine -> always overwrite (carries upgrades).
  cp "$PKG_DIR/payload/hooks/skill-gate-guard.sh" "$CLAUDE_DIR/hooks/"
  # Its Bash path finder (which files a Bash command writes) — engine too, always overwrite.
  mkdir -p "$CLAUDE_DIR/hooks/_lib"
  cp "$PKG_DIR/payload/hooks/_lib/bash-write-targets.py" "$PKG_DIR/payload/hooks/_lib/shell_text.py" "$CLAUDE_DIR/hooks/_lib/"
fi
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
SKILL_SRC="$PKG_DIR/payload/skills/instructions-tuning"
SKILL_DST="$CLAUDE_DIR/skills/instructions-tuning"

if [ "$LINK" = 1 ]; then
  # Replacing a real directory would silently discard edits made in place, and
  # those edits are exactly what --link exists to stop losing. Refuse unless the
  # content already matches the package (or the user insists with --force).
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
  echo "linked skill -> $SKILL_SRC" >&2
elif [ -L "$SKILL_DST" ]; then
  # Already linked: copying would write straight through the symlink into the
  # package. Leave the link alone — dropping it needs an explicit re-install.
  echo "kept existing symlink -> $(readlink "$SKILL_DST") (re-run without --link after removing it to switch back to a copy)" >&2
else
  # The whole folder: SKILL.md points at its situation files, a lone SKILL.md would point at nothing.
  mkdir -p "$SKILL_DST"
  cp -R "$SKILL_SRC/." "$SKILL_DST/"
fi

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
  def gate: (.command // "") | test("skill-gate-guard.sh");
  def has_bash: (.matcher // "") | test("(^|[|])Bash($|[|])");
  def gate_only: ((.hooks // []) | length) == 1 and any(.hooks[]?; gate);
  .hooks = (.hooks // {})
  # Upgrade from Write|Edit: Bash already gated somewhere -> leave it. Otherwise widen the matcher only when the
  # gate sits alone in its group; a shared group would drag its other hooks into Bash, so add a Bash group instead.
  | .hooks.PreToolUse = ((.hooks.PreToolUse // []) as $g
      | if present($g; $guard)
        then (if any($g[]; has_bash and any(.hooks[]?; gate)) then $g
              elif any($g[]; .matcher == "Write|Edit" and gate_only)
              then $g | map(if .matcher == "Write|Edit" and gate_only then .matcher = "Write|Edit|Bash" else . end)
              else $g + [ {matcher:"Bash", hooks:[{type:"command", command:$guard, "_cc_it":true}]} ] end)
        else $g + [ {matcher:"Write|Edit|Bash", hooks:[{type:"command", command:$guard, "_cc_it":true}]} ] end)
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
  echo "  PreToolUse  matcher 'Write|Edit|Bash' -> command: $GUARD" >&2
  echo "  PostToolUse matcher 'Skill'      -> command: $SKILLLOG" >&2
fi

# --- Step 3: .gitignore (per-machine state) ---
GI="$TARGET/.gitignore"; START="# >>> instructions-tuning >>>"; END="# <<< instructions-tuning <<<"
if [ ! -f "$GI" ] || ! grep -qF "$START" "$GI"; then
  printf '\n%s\n.claude/state/\n%s\n' "$START" "$END" >> "$GI"
fi
# --link: the skill is a symlink into this machine's clone, so it never goes into the project's git.
LSTART="# >>> instructions-tuning --link >>>"
if [ "$LINK" = 1 ] && ! grep -qF "$LSTART" "$GI"; then
  printf '\n%s\n.claude/skills/instructions-tuning\n%s\n' "$LSTART" "# <<< instructions-tuning --link <<<" >> "$GI"
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
           $( [ "$LINK" = 1 ] && echo "^ symlinked into this clone (gitignored), the gate runs through a shim — git pull here updates both" || echo "^ a copy; re-run with --link to follow this clone instead" )
  hooks:   skill-gate-guard.sh   (PreToolUse Write|Edit|Bash — blocks edits to governed paths
                                   until the owner skill was invoked this context window)
           skill-invocation-log.sh (PostToolUse Skill — records invocations; shared w/ cc-learning-log)
  gates:   skill-gate.config.json   <-- EDIT THIS: map this project's paths -> required skill
  state:   .claude/state/skill-invocations.jsonl   (per-machine, gitignored)
  requires: jq; python3 for Bash writes (without it they pass ungated)

NEXT: open .claude/skill-gate.config.json and add your project's gates, e.g.
  { "path_prefix": "docs/specs/", "skill": "instructions-tuning" }
  { "path_prefix": "tasks/",      "skill": "task" }
SUMMARY
