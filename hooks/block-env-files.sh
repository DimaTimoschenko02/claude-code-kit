#!/usr/bin/env bash
# block-env-files.sh — PreToolUse guard.
# Blocks reading / copying / sourcing any .env file (across all projects),
# complementing block-secrets.sh.
#
# Whitelist: .env.example / .env.sample / .env.template / .env.dist
# (these are secret-free templates).
#
# This filename deliberately contains NO 'secret/creds/password' word, so that
# block-secrets.sh does not block us during self-edit.

set -u

# JSON payload в stdin: {tool_name, tool_input: {...}}
payload=$(cat 2>/dev/null || true)
[[ -z "$payload" ]] && exit 0

tool=$(printf '%s' "$payload" | jq -r '.tool_name // empty' 2>/dev/null)
[[ -z "$tool" ]] && exit 0

deny() {
    local reason="$1"
    >&2 echo "🛑 BLOCKED by block-env-files.sh: $reason"
    >&2 echo "   If this is a false positive, the rule lives in ~/.claude/hooks/block-env-files.sh"
    exit 2
}

# Whitelist: путь является шаблоном — пропускаем
is_template() {
    local p="$1"
    [[ "$p" == *.env.example* ]] && return 0
    [[ "$p" == *.env.sample* ]] && return 0
    [[ "$p" == *.env.template* ]] && return 0
    [[ "$p" == *.env.dist* ]] && return 0
    [[ "$p" == *env.validation.ts* ]] && return 0   # это TS-схема, не секреты
    [[ "$p" == *.env.d.ts* ]] && return 0
    return 1
}

# Является ли путь .env-файлом проекта
looks_like_env() {
    local p="$1"
    # содержит /.env или начинается с .env или /env. + типичные суффиксы
    if [[ "$p" =~ (^|/)\.env(\.|$|[a-zA-Z0-9_-]) ]]; then
        return 0
    fi
    # /env/file.env, /config/.env, etc.
    if [[ "$p" == *.env ]] || [[ "$p" == *.envrc ]]; then
        return 0
    fi
    return 1
}

case "$tool" in
    Read|Edit|Write|NotebookRead|NotebookEdit)
        path=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
        [[ -z "$path" ]] && exit 0
        if looks_like_env "$path" && ! is_template "$path"; then
            deny "tried to access .env file: $path"
        fi
        ;;
    Glob)
        pattern=$(printf '%s' "$payload" | jq -r '.tool_input.pattern // empty')
        # pattern explicitly targeting env files (не просто '*' который покажет имена)
        if [[ "$pattern" == *.env* ]] && [[ "$pattern" != *.example* ]] && [[ "$pattern" != *.sample* ]]; then
            # Glob возвращает только имена — но если pattern узкий типа '**/.env',
            # это сигнал что хотели именно env. Блокируем precaution.
            deny "Glob pattern targets env files: $pattern"
        fi
        ;;
    Grep)
        # Grep ищет внутри файлов — это уже чтение содержимого
        path=$(printf '%s' "$payload" | jq -r '.tool_input.path // ""')
        glob=$(printf '%s' "$payload" | jq -r '.tool_input.glob // ""')
        # если path сам .env или glob targets .env
        if looks_like_env "$path" && ! is_template "$path"; then
            deny "Grep into .env file: $path"
        fi
        if [[ "$glob" == *.env* ]] && [[ "$glob" != *.example* ]] && [[ "$glob" != *.sample* ]]; then
            deny "Grep glob targets env files: $glob"
        fi
        ;;
    Bash)
        cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty')
        [[ -z "$cmd" ]] && exit 0

        # Опасные глаголы + .env в той же команде
        # (cat/head/tail/less/more/bat/sed/awk/source/. /xxd/od/hexdump/cp/mv/tar/zip/gzip/base64)
        # упоминают .env где-то в command — блок.
        # ls/find/stat/file — НЕ блокируем (не выводят содержимое).
        if [[ "$cmd" =~ (^|[[:space:];|&]+)(cat|head|tail|less|more|bat|nl|tac|rev|column|cut|paste|join|sort|uniq|wc|tr|fmt|fold|expand|unexpand|grep|egrep|fgrep|rg|ag|sed|awk|gawk|perl|python|python3|ruby|node|read|xxd|od|hexdump|strings|dd|cp|mv|rsync|scp|tar|zip|gzip|bzip2|xz|base64|openssl|gpg|source|\.)([[:space:]]|$) ]]; then
            # Содержит .env (не как .env.example) и не как ENV переменная env=
            if [[ "$cmd" == *.env* ]] || [[ "$cmd" == *.envrc* ]]; then
                # Whitelist шаблонов
                if [[ "$cmd" == *.env.example* ]] || [[ "$cmd" == *.env.sample* ]] || [[ "$cmd" == *.env.template* ]] || [[ "$cmd" == *.env.dist* ]]; then
                    : # ok
                else
                    deny "command reads/copies .env content: $(printf '%s' "$cmd" | head -c 120)"
                fi
            fi
        fi

        # Source / dotenv-pipe pattern
        if [[ "$cmd" =~ (^|[[:space:];|&]+)(source|\.)[[:space:]]+[^[:space:]]*\.env ]]; then
            if [[ "$cmd" != *.env.example* ]] && [[ "$cmd" != *.env.sample* ]]; then
                deny "tried to source .env: $(printf '%s' "$cmd" | head -c 120)"
            fi
        fi

        # Прямой redirect / heredoc / pipe в .env (вывод содержимого через cat <<)
        if [[ "$cmd" =~ \<[[:space:]]*[^[:space:]]*\.env([^a-zA-Z0-9_]|$) ]]; then
            if [[ "$cmd" != *.env.example* ]] && [[ "$cmd" != *.env.sample* ]]; then
                deny "redirect from .env: $(printf '%s' "$cmd" | head -c 120)"
            fi
        fi

        # docker exec/run + .env — блок (передача env-файла в контейнер раскрывает значения в logs/inspect)
        if [[ "$cmd" =~ docker[[:space:]]+(exec|run|compose|cp).*\.env ]]; then
            if [[ "$cmd" != *.env.example* ]]; then
                deny "docker + .env: $(printf '%s' "$cmd" | head -c 120)"
            fi
        fi
        ;;
esac

exit 0
