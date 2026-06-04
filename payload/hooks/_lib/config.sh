#!/usr/bin/env bash
# Config loader for cc-learning-log.
#
# Precedence (lowest -> highest): hardcoded default -> config file -> CCLL_* env.
# The hardcoded layer is ALWAYS applied first, so a missing jq or a corrupt
# config degrades to defaults and never breaks a hook.
#
# Caller must set $LL_CLAUDE_DIR (the target's .claude dir) before sourcing.
# Exposes LL_* variables (strings; booleans compared as the strings "true"/"false").

# --- Hardcoded defaults (must mirror config.defaults.json) ---
LL_ENABLED="true"
LL_THRESHOLD="6"
LL_MODEL="claude-haiku-4-5-20251001"
LL_MAX_CHUNK_BYTES="300000"
LL_STALE_LOCK_MINUTES="5"
LL_SKILL_LOG_LOOKBACK="20"
LL_TIMEOUT="120"
LL_FORCE_SUB="true"
LL_PERSONA="the user"
LL_LANGUAGE="the conversation's language"
LL_EXTRA=""
LL_WIKILINKS="false"

# --- Config file layer ---
_ll_cfg="${LL_CLAUDE_DIR:-}/learning-log.config.json"
if command -v jq >/dev/null 2>&1 && [ -f "$_ll_cfg" ] && jq -e 'type=="object"' "$_ll_cfg" >/dev/null 2>&1; then
  _ll_get() { jq -r --arg k "$1" '.[$k] // empty' "$_ll_cfg" 2>/dev/null; }
  _v=$(_ll_get enabled);                       [ -n "$_v" ] && LL_ENABLED="$_v"
  _v=$(_ll_get threshold);                      [ -n "$_v" ] && LL_THRESHOLD="$_v"
  _v=$(_ll_get model);                          [ -n "$_v" ] && LL_MODEL="$_v"
  _v=$(_ll_get max_chunk_bytes);                [ -n "$_v" ] && LL_MAX_CHUNK_BYTES="$_v"
  _v=$(_ll_get stale_lock_minutes);             [ -n "$_v" ] && LL_STALE_LOCK_MINUTES="$_v"
  _v=$(_ll_get skill_log_lookback);             [ -n "$_v" ] && LL_SKILL_LOG_LOOKBACK="$_v"
  _v=$(_ll_get classifier_timeout_seconds);     [ -n "$_v" ] && LL_TIMEOUT="$_v"
  _v=$(_ll_get force_subscription);             [ -n "$_v" ] && LL_FORCE_SUB="$_v"
  _v=$(_ll_get persona);                        [ -n "$_v" ] && LL_PERSONA="$_v"
  _v=$(_ll_get language);                        [ -n "$_v" ] && LL_LANGUAGE="$_v"
  _v=$(_ll_get classifier_extra_instructions);  [ -n "$_v" ] && LL_EXTRA="$_v"
  _v=$(_ll_get wikilinks);                       [ -n "$_v" ] && LL_WIKILINKS="$_v"
  unset _v
fi

# --- Env override layer (CCLL_*) ---
[ -n "${CCLL_ENABLED:-}" ]          && LL_ENABLED="$CCLL_ENABLED"
[ -n "${CCLL_THRESHOLD:-}" ]        && LL_THRESHOLD="$CCLL_THRESHOLD"
[ -n "${CCLL_MODEL:-}" ]            && LL_MODEL="$CCLL_MODEL"
[ -n "${CCLL_MAX_CHUNK_BYTES:-}" ]  && LL_MAX_CHUNK_BYTES="$CCLL_MAX_CHUNK_BYTES"
[ -n "${CCLL_TIMEOUT:-}" ]          && LL_TIMEOUT="$CCLL_TIMEOUT"
[ -n "${CCLL_FORCE_SUB:-}" ]        && LL_FORCE_SUB="$CCLL_FORCE_SUB"
[ -n "${CCLL_PERSONA:-}" ]          && LL_PERSONA="$CCLL_PERSONA"
[ -n "${CCLL_WIKILINKS:-}" ]        && LL_WIKILINKS="$CCLL_WIKILINKS"
[ -n "${CCLL_STALE_LOCK_MINUTES:-}" ] && LL_STALE_LOCK_MINUTES="$CCLL_STALE_LOCK_MINUTES"
[ -n "${CCLL_SKILL_LOG_LOOKBACK:-}" ] && LL_SKILL_LOG_LOOKBACK="$CCLL_SKILL_LOG_LOOKBACK"
[ -n "${CCLL_LANGUAGE:-}" ]         && LL_LANGUAGE="$CCLL_LANGUAGE"
[ -n "${CCLL_EXTRA:-}" ]            && LL_EXTRA="$CCLL_EXTRA"
