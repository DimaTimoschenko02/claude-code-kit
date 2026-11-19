"""Data is not the command: a word or path the command only carries as text passes, a real read or dump does not."""
import json
import os
import shutil
import subprocess
from pathlib import Path


def bash_executable():
    # On Windows a bare `bash` from native Python is the WSL launcher, not Git Bash.
    if os.name != 'nt':
        return 'bash'
    git = shutil.which('git')
    candidates = [Path(git).parent.parent / 'bin' / 'bash.exe'] if git else []
    candidates.append(Path(os.environ.get('ProgramFiles', 'C:/Program Files')) / 'Git' / 'bin' / 'bash.exe')
    return next((str(c) for c in candidates if c.is_file()), 'bash')


BASH = bash_executable()
HOOK = os.environ.get('GUARD_HOOK') or str(Path(__file__).resolve().parents[1] / 'hooks' / 'block-secrets.sh')

ALLOWED = [
    # A builtin's name inside a search pattern is text.
    "rg -n 'promptTier|readonly|export' lib",
    "git grep -n -E '^(let|const|export let|export const)|readonly|jump' -- docs",
    'rg -n "a|readonly|b" src',
    # Text a heredoc writes into a file is data; so is a heredoc body fed to an interpreter for the dump rule.
    "cat > docs/note.md <<'EOF'\nRun the tests with node --env-file=.env.test\nexport |\nEOF",
    "cat <<'EOF' > docs/note.md\nsee .env.local\nEOF",
    "tee -a docs/log.md <<'EOF'\nthe .env.test file is local\nEOF",
    "python3 - <<'PY'\nprint('readonly |')\nPY",
    # An existence test reads nothing.
    'test -f .env.test && pnpm vitest run test/a.spec.ts',
    '[ -s .env.test ] && echo ready',
    # A quoted search pattern is what the tool looks for; the files it searches are still checked.
    "rg -n '\\.env\\.test|DATABASE_URL' scripts",
    "git grep -n -E 'ctx.app|ctx.env|Date' HEAD -- server",
    "rg -n 'ctx.env' -g '*.ts' src",
]
BLOCKED = [
    # Real dumps stay refused, quoted or not.
    "env | rg 'VITEST|CI'",
    'cd x; env | sort',
    "ssh host 'cd x; env | sort'",
    "bash -c 'set'",
    "bash <<'EOF'\nenv | sort\nEOF",
    'printenv | grep "$X"',
    "cat > a.md <<'EOF'\ntext\nEOF\nprintenv",
    # Real reads stay refused: the heredoc's target, the code an interpreter runs, a quoted path.
    "cat > .env <<'EOF'\nA=1\nEOF",
    'test -f .env.test && cat .env.test',
    "python3 - <<'PY'\nprint(open('.env').read())\nPY",
    "python3 -c 'print(open(\".env\").read())'",
    "cat '.env'",
    "node --env-file=.env.test -e '1'",
    # A searched file, a pattern file and a file filter are reads, quoted or not.
    "rg -n 'x' .env",
    "rg -f '.env' src",
    "rg --hidden -g '.env*' PASSWORD",
    "grep -r --include '*.env' TOKEN .",
    'rg -n "process.env.API_TOKEN" src',
]

failures = []
for command, permitted in [(c, True) for c in ALLOWED] + [(c, False) for c in BLOCKED]:
    payload = {'tool_name': 'Bash', 'tool_input': {'command': command}}
    result = subprocess.run([BASH, HOOK], input=json.dumps(payload), text=True, capture_output=True)
    if (result.returncode == 0) != permitted:
        failures.append((command, 'allowed' if permitted else 'blocked', result.returncode, result.stderr.strip()[:120]))
print('data-not-command guard', len(ALLOWED) + len(BLOCKED), 'cases', 'PASS' if not failures else 'FAIL')
for failure in failures:
    print('  expected', failure[1], '-', repr(failure[0]), '-> exit', failure[2], failure[3])
if failures:
    raise SystemExit(1)
