import json
import subprocess
from pathlib import Path

HOOK = str(Path(__file__).resolve().parents[1] / 'hooks' / 'block-secrets.sh')
cases = []
for name in ['.env.example', '/project/.env.example', '/project/.claude/worktrees/PH-180/.env.example']:
    for tool in ['Read', 'Edit', 'Write']:
        cases.append(({'tool_name': tool, 'tool_input': {'file_path': name}}, True))
for command in ['cat .env.example', 'git diff -- .env.example', 'cat "/project/.env.example"', 'git add -- .env.example']:
    cases.append(({'tool_name': 'Bash', 'tool_input': {'command': command}}, True))
for name in ['.env', '/project/.env', '/project/.env.test', '/project/.env.production', '/project/.env.example.local', '/project/.env.example~', '/project/private.env.example', '/project/.mcp.json']:
    cases.append(({'tool_name': 'Read', 'tool_input': {'file_path': name}}, False))
for command in ['cat .env', 'cat .env.test', 'cat .env.production', 'cat .env.example.local', 'cat .env.example~', 'cat private.env.example', 'cat .env.example .env', 'cat .env.example/../.env', 'cat .env.example$SUFFIX', 'cat .env.example .mcp.json']:
    cases.append(({'tool_name': 'Bash', 'tool_input': {'command': command}}, False))
for command in ['cat .env.example*', 'cat .env.example?', 'cat .env.example[0-9]', 'cat .env.example{,.production}', "cat '.env.example backup'", 'cat private+.env.example', "python -c \"open('/project/.env.example')\"", 'cat .env.example; cat .env.production', 'cat private:.env.example', 'cat /project/.env.production:.env.example', 'git show HEAD:.env.example']:
    cases.append(({'tool_name': 'Bash', 'tool_input': {'command': command}}, False))
for path, allowed in [('/project/.env.example', True), ('/project/.env', False), ('/project/.env.example.local', False)]:
    cases.append(({'tool_name': 'apply_patch', 'tool_input': {'command': f'*** Begin Patch\n*** Update File: {path}\n@@\n-a\n+b\n*** End Patch'}}, allowed))

for hook in [HOOK]:
    failures = []
    for payload, permitted in cases:
        expected = permitted
        result = subprocess.run(['bash', hook], input=json.dumps(payload), text=True, capture_output=True)
        if (result.returncode == 0) != expected:
            failures.append((payload, result.returncode, result.stderr))
    print('public registry guard', len(cases), 'cases', 'PASS' if not failures else failures)
    if failures:
        raise SystemExit(1)
