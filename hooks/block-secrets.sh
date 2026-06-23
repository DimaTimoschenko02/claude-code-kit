#!/bin/bash
# PreToolUse hook: prevents Claude from reading credentials or accidentally exposing them.
# Reads JSON from stdin, exits 2 + writes to stderr to block the tool call.
#
# DESIGN CONSTRAINT (do not break): this file is named *secret* so is_sensitive_path()
# blocks Read/Edit/Write on it. It is therefore updated out-of-band via `cp` from a
# neutrally-named temp file. For that `cp` to keep working under THIS hook, the Bash
# command-matching regexes below must NOT match the literal "block-secrets.sh"
# (i.e. never add a bare "secret"/"password" substring to the Bash branch — keep the
# Bash branch matching file *suffixes* and known path literals only). Generic
# secret/password/creds matching lives in is_sensitive_path() for the path-tool branch.
#
# THREAT MODEL & RESIDUAL LIMITATIONS (honest scope):
#   The $SENS literal-mention rule blocks ANY command containing a known credential path
#   literal, regardless of the command used (cat/jq/scp/eval/python/…). This makes the
#   reader-command and redirect rules below largely redundant defense-in-depth.
#   What it CANNOT catch (out of scope — a regex on the command string can't):
#     - dynamically built paths / string-splitting:  F=mcp; cat ~/work/.$F.json   |  ca""t .env
#     - filenames that only appear in tool OUTPUT (e.g. Glob '*.json' listing .mcp.json — but
#       the filename is not the secret; READING its contents is still blocked).
#   Rationale: this hook guards against accidental/direct leaks and known footguns, not a
#   deliberately-obfuscating agent (which already holds the shell).

set -u

input=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$input")

deny() {
  echo "🛑 BLOCKED by block-secrets.sh: $1" >&2
  echo "   If this is a false positive, the rule lives in ~/.claude/hooks/block-secrets.sh" >&2
  exit 2
}

# Path patterns considered sensitive — any read/write/edit/grep/glob on these is blocked
is_sensitive_path() {
  local p="$1"
  case "$p" in
    *.env|*.env.*|*/.env|\
    *creds*|*credential*|*secret*|*password*|*passwd|\
    *.mcp.json|*/mcp.json|\
    *.pgpass|*.netrc|*.npmrc|\
    */.aws/credentials|*/.aws/config|\
    */.claude.json|*/.claude/.credentials.json|*.credentials.json|\
    */.claude/db-creds.env|\
    */.git-credentials|*/.config/glab-cli/*|*/glab-cli/config*|\
    */.config/gh/*|*/gh/hosts.yml|\
    */.zshrc|*/.bashrc|*/.zsh_history|*/.bash_history|\
    */.docker/config.json|*/.kube/config|\
    *.pem|*.p12|*.pfx|*.kdbx|\
    */id_rsa|*/id_ed25519|*/id_ecdsa|*/.ssh/id_*)
      return 0 ;;
  esac
  return 1
}

case "$tool" in
  Read|Edit|Write|NotebookEdit)
    path=$(jq -r '.tool_input.file_path // ""' <<<"$input")
    if is_sensitive_path "$path"; then
      deny "tried to access sensitive file: $path"
    fi
    ;;
  Grep|Glob)
    path=$(jq -r '.tool_input.path // ""' <<<"$input")
    pattern=$(jq -r '.tool_input.pattern // ""' <<<"$input")
    if is_sensitive_path "$path" || is_sensitive_path "$pattern"; then
      deny "tried to grep/glob sensitive path: $path / $pattern"
    fi
    ;;
  WebFetch)
    # Claude has no legit reason to WebFetch a local file:// URL — that bypasses the Read guard.
    url=$(jq -r '.tool_input.url // ""' <<<"$input")
    if grep -qiE '^[[:space:]]*file://' <<<"$url"; then
      deny "WebFetch of a file:// URL (local file read vector)"
    fi
    ;;
  Bash)
    cmd=$(jq -r '.tool_input.command // ""' <<<"$input")

    # Known credential-file suffixes / path literals. Kept WITHOUT bare "secret"/"password"
    # words on purpose (see DESIGN CONSTRAINT above).
    SENS='(\.env\b|\.env\.|\.mcp\.json\b|\.claude\.json\b|\.credentials\.json\b|\.git-credentials\b|\.pgpass\b|\.netrc\b|\.npmrc\b|\.aws/credentials\b|/\.config/glab-cli/|/glab-cli/config|/\.config/gh/|/gh/hosts\.yml)'

    # Direct file reads of secret files via a known reader command (redundant with the
    # literal-mention rule below, kept as cheap defense-in-depth).
    READERS='\bcat\b|\bhead\b|\btail\b|\bless\b|\bmore\b|\bbat\b|\bxxd\b|\bhexdump\b|\bod\b|\bstrings\b|\bnl\b|\bcut\b|\bpaste\b|\brev\b|\bfold\b|\bfmt\b|\bcolumn\b|\bbase64\b|\bbase32\b|\baw[k]\b|\bs[e]d\b|\btee\b|\bcp\b|\bmv\b|\bdd\b|\bjq\b|\byq\b|\bgrep\b|\begrep\b|\bfgrep\b|\brg\b|\bvi\b|\bvim\b|\bview\b|\bnano\b|\bemacs\b|\bpython3?\b|\bperl\b|\bruby\b|\bnode\b|\bphp\b|\bsource\b|\bmapfile\b|\breadarray\b|\bopenssl\b|\bscp\b|\brsync\b|\bsftp\b|\bcurl\b|\bwget\b|\btar\b'
    if grep -qE "($READERS)[[:space:]]+[^|;]*$SENS" <<<"$cmd"; then
      deny "command reads a credentials file"
    fi

    # Reading a sensitive file via redirect or $(<file)
    if grep -qE "(<|<<<)[[:space:]]*[^|;&<>()]*$SENS" <<<"$cmd"; then
      deny "command reads a sensitive file via redirect or \$(<...)"
    fi

    # ANY mention of the creds-file path literals (the workhorse — catches git show HEAD:.env,
    # python open('.mcp.json'), eval cat .env, scp .mcp.json host:, etc. — anything naming the path)
    if grep -qE "$SENS" <<<"$cmd"; then
      deny "command references a sensitive path literal"
    fi

    # eval can assemble a credential-reading command from a non-literal (the one indirection
    # class worth denying outright — Claude has no legitimate use for eval here)
    if grep -qE '(^|[[:space:];|&(])eval([[:space:]]|$)' <<<"$cmd"; then
      deny "eval can construct credential-reading commands that bypass static checks"
    fi

    # Env dumps (builtins)
    if grep -qE '(^|[[:space:];|&])(printenv|env|set|declare|export|typeset|readonly)([[:space:]]*$|[[:space:]]*\|)' <<<"$cmd"; then
      deny "command would dump environment variables"
    fi
    if grep -qE '(^|[[:space:];|&])compgen[[:space:]]+(-v\b|-e\b|-A[[:space:]]+variable|-A[[:space:]]+export)' <<<"$cmd"; then
      deny "compgen lists shell/env variable names (env-dump vector)"
    fi
    # Env-dump builtin as the whole payload of `sh -c '...'` (the trailing quote breaks the
    # main env-dump anchor). Tight: requires the builtin to be immediately followed by the
    # closing quote, so `bash -c 'set -e; ...'` and `env VAR=x cmd` are NOT matched.
    if grep -qE "(bash|sh|zsh|dash|ksh)[[:space:]]+-c[[:space:]]*['\"][[:space:]]*(printenv|env|set|declare|typeset|export[[:space:]]+-p|compgen[[:space:]]+-[evA])[[:space:]]*;?[[:space:]]*['\"]" <<<"$cmd"; then
      deny "env-dump builtin inside a -c quoted command"
    fi

    # Env dumps via interpreter one-liners (no file named, so $SENS misses them)
    if grep -qE 'jq[[:space:]]+-n[[:space:]]+env|node[[:space:]]+-e[^|]*process\.env|(python3?|py)[[:space:]]+-c[^|]*os\.environ|ruby[[:space:]]+-e[^|]*\bENV\b|php[[:space:]]+-r[^|]*getenv|deno[[:space:]][^|]*Deno\.env' <<<"$cmd"; then
      deny "interpreter one-liner dumps the environment"
    fi

    # ps showing the environ column
    if grep -qE 'ps[[:space:]][^|]*\benviron\b' <<<"$cmd"; then
      deny "ps ... environ column dumps process environment"
    fi

    # Echo/printf of secret-pattern variables. The variable name (after $ or ${) must either
    # start with a known secret prefix, be a whole-word secret name, or contain a
    # _PASS/_TOKEN/_KEY/... segment. Anchored to avoid BYPASS/RECONNECT/MONKEY/CACHEKEY etc.
    # TOKEN/SECRET/PASSWORD allow an uppercase prefix (catches $ACCESSTOKEN, $MYSECRET, $DBPASSWORD);
    # bare KEY does NOT (would re-introduce $MONKEY/$DONKEY/$CACHEKEY false positives) — KEY only via
    # underscore (_KEY) or explicit APIKEY/ACCESSKEY/SECRETKEY.
    if grep -qE '(echo|printf|print)[[:space:]]+[^|;]*\$\{?(PG_|PGPASS|MYSQL_|MONGO|REDIS|DATABASE|CONNECTION|[A-Z0-9]*PASSWORD\b|[A-Z0-9]*SECRET\b|[A-Z0-9]*TOKEN\b|APIKEY\b|ACCESSKEY\b|SECRETKEY\b|[A-Z0-9]+_(PASS|PASSWORD|SECRET|TOKEN|KEY|CRED|DSN))' <<<"$cmd"; then
      deny "command echoes a secret-like variable"
    fi

    # claude mcp list without grep filter — known leak vector
    if grep -qE 'claude[[:space:]]+mcp[[:space:]]+list' <<<"$cmd" && ! grep -qE 'claude[[:space:]]+mcp[[:space:]]+list[^|]*\|[^|]*grep' <<<"$cmd"; then
      deny "claude mcp list without grep filter — past leak vector"
    fi

    # git CLI commands that print tokens / dump config in cleartext
    if grep -qE 'gh[[:space:]]+auth[[:space:]]+token' <<<"$cmd"; then
      deny "gh auth token prints the GitHub token"
    fi
    if grep -qE 'glab[[:space:]]+auth[^|]*--show-token|glab[[:space:]]+auth[[:space:]]+token' <<<"$cmd"; then
      deny "glab auth --show-token prints the GitLab token"
    fi
    if grep -qE 'git[[:space:]]+credential([[:space:]]|-)' <<<"$cmd"; then
      deny "git credential command reads stored credentials"
    fi
    if grep -qE 'git[[:space:]]+config[^|]*(--list|--get-regexp|[[:space:]]-l\b|credential|url\..*insteadof|http\..*extraheader)' <<<"$cmd" \
       && ! grep -qE '\|[^|]*grep' <<<"$cmd"; then
      deny "git config dump may surface stored credentials (filter with | grep)"
    fi

    # macOS keychain dumps
    if grep -qE 'security[[:space:]]+(find-(generic|internet)-password|find-certificate|export[[:space:]])' <<<"$cmd"; then
      deny "security keychain command can expose a stored secret"
    fi

    # Docker — block creds-leaking patterns
    if grep -qE 'docker[[:space:]]+(container[[:space:]]+)?run[^|]*-e[[:space:]]*(PG_|MYSQL_|MONGO_|REDIS|DATABASE|PASSWORD|SECRET|TOKEN|APIKEY|[A-Z0-9]+_(PASS|PASSWORD|SECRET|TOKEN|KEY|CRED|DSN))' <<<"$cmd"; then
      deny "docker run with credentials in container env (use docker exec -e instead)"
    fi
    if grep -qE 'docker[[:space:]]+(container[[:space:]]+)?exec[^|]*(printenv|[[:space:]]env([[:space:]]*$|[[:space:]]*\|)|cat[[:space:]]+/proc/[0-9*]+/environ)' <<<"$cmd"; then
      deny "docker exec dumping process environment"
    fi
    if grep -qE 'docker[[:space:]]+(container[[:space:]]+)?inspect[^|]*(\.Config|\bEnv\b|environ)' <<<"$cmd"; then
      deny "docker inspect exposing container environment"
    fi
    if grep -qE 'docker[[:space:]]+(container[[:space:]]+)?inspect[^|]*\bpgcli\b' <<<"$cmd"; then
      deny "docker inspect pgcli (defense in depth, even though per-exec env is not stored)"
    fi
    if grep -qE 'docker[[:space:]]+(container[[:space:]]+)?logs[^|]*\bpgcli\b' <<<"$cmd"; then
      deny "docker logs pgcli — psql may have logged URL"
    fi

    # /proc/PID/environ reads on host (numeric, self, $$, $BASHPID, etc.)
    if grep -qE '/proc/[^/[:space:]]+/environ' <<<"$cmd"; then
      deny "reading process environment from /proc"
    fi

    # ps with env-showing flags
    if grep -qE 'ps[[:space:]]+[a-zA-Z-]*\baux[a-z]*e\b|ps[[:space:]]+[a-zA-Z-]*\bauxe\b|ps[[:space:]]+-?[a-zA-Z]*ww?e\b' <<<"$cmd"; then
      deny "ps command shows process environment"
    fi

    # kubectl secret reads in formats that expose value (yaml/json/jsonpath) without grep filter
    if grep -qE 'kubectl[^|]*get[[:space:]]+secret[^|]*-o[[:space:]]*(yaml|json|jsonpath)' <<<"$cmd" \
       && ! grep -qE '\|[^|]*grep' <<<"$cmd"; then
      deny "kubectl get secret -o yaml/json/jsonpath without grep filter — would dump cred value"
    fi

    # Cloud secret managers — always return plain credential value
    if grep -qE 'aws[[:space:]]+secretsmanager[[:space:]]+get-secret-value' <<<"$cmd"; then
      deny "aws secretsmanager get-secret-value returns plaintext credential"
    fi
    if grep -qE 'gcloud[[:space:]]+secrets[[:space:]]+versions[[:space:]]+access' <<<"$cmd"; then
      deny "gcloud secrets versions access returns plaintext credential"
    fi
    if grep -qE 'az[[:space:]]+keyvault[[:space:]]+secret[[:space:]]+show' <<<"$cmd"; then
      deny "az keyvault secret show returns plaintext credential"
    fi
    ;;
esac

exit 0
