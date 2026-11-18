"""Variable names in commands: code that reads a named variable passes, credential names and env files do not."""
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
    # A named variable read in code is not a path to an env file.
    'rg -n "process.env.ANSWER_EXAMPLE_VAULT_ROOT" lib/a.mjs',
    "grep -rn 'process.env.NODE_ENV' src | head",
    'rg -n "import.meta.env.VITE_API_URL" src',
    "node - <<'JS'\nconst root = process.env.VAULT_ROOT || '.';\nconsole.log(root.length);\nJS",
    'rg "process.env.PORT, process.env.HOST" src',
    # Names that only resemble a credential word stay printable.
    'echo $HOME',
    'echo $MONKEY',
    'echo "$CACHEKEY"',
]
BLOCKED = [
    # Env files, whatever stands before or after the name.
    'cat .env',
    'cat .env.local',
    'cat prod.env',
    'cat app.env.production',
    'cat process.env.local',
    'cat process.env.LOCAL.bak',
    'cat config/process.env.PROD',
    'cat my.process.env.NODE_ENV',
    'cat x-process.env.PROD',
    'cat .env; rg process.env.NODE_ENV src',
    # A credential-looking name stays blocked in code references too.
    'rg -n "process.env.API_TOKEN" src',
    'rg "process.env.GITHUB_PERSONAL_ACCESS_TOKEN" .',
    'rg "import.meta.env.VITE_PRIVATE_KEY" src',
    # A bare accessor and an inline dump are not a named read.
    'rg -n "process.env" src',
    'node -e "console.log(process.env.NODE_ENV)"',
    # Printing a credential variable: any number of name segments before the keyword.
    'echo $SOME_TOKEN',
    'echo $DB_PASSWORD',
    'echo $AWS_SECRET_ACCESS_KEY',
    'echo $MY_APP_TOKEN',
    'echo $GITHUB_PERSONAL_ACCESS_TOKEN',
    'printf %s "$TELEGRAM_BOT_TOKEN"',
    'echo ${STORE_READ_ONLY_TOKEN}',
]

failures = []
for command, permitted in [(c, True) for c in ALLOWED] + [(c, False) for c in BLOCKED]:
    payload = {'tool_name': 'Bash', 'tool_input': {'command': command}}
    result = subprocess.run([BASH, HOOK], input=json.dumps(payload), text=True, capture_output=True)
    if (result.returncode == 0) != permitted:
        failures.append((command, 'allowed' if permitted else 'blocked', result.returncode, result.stderr.strip()[:120]))
print('variable names guard', len(ALLOWED) + len(BLOCKED), 'cases', 'PASS' if not failures else 'FAIL')
for failure in failures:
    print('  expected', failure[1], '-', repr(failure[0]), '-> exit', failure[2], failure[3])
if failures:
    raise SystemExit(1)
