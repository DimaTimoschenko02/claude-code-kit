import { describe, expect, test } from 'claude-code/testing'

import { describeCommand, describeJs, noteLine } from '../hooks/doing'
import { clipWords, codexProc, lsofThreads, stemOf } from '../hooks/parse'

// Command shapes copied from real Codex rollouts (paths under /home/fake): what the pane says instead of the code.
describe('a command as a phrase', () => {
  const cases: [string, string][] = [
    ["nl -ba .claude/memory/camera-feel/reference-videos.md | sed -n '65,84p'", 'reading reference-videos.md'],
    ["sed -n '150,290p' CLAUDE.md", 'reading CLAUDE.md'],
    ['cat CLAUDE.md; cat .claude/skills/playtest-video/SKILL.md', 'reading CLAUDE.md +1'],
    ["LC_ALL=C python3 - <<'PY'\nimport subprocess\nfrom pathlib import Path\nfor x in range(3):\n  print(x)\nPY", 'running a Python script'],
    ["mkdir -p /home/fake/tmp/p2/shots /home/fake/tmp/out; LC_ALL=C ffmpeg -v error -ss 7.8 -i reference-videos/ref19_vertical_free_ride_a.mov -frames:v 1 /home/fake/tmp/p2/shots/initial.png", 'cutting frames from ref19_vertical_free_ride_a.mov'],
    ['ffprobe -v error -show_entries stream=nb_frames reference-videos/ref14_hill_climb_launch.mov', 'probing ref14_hill_climb_launch.mov'],
    ["rg -n 'ref19|video|видео' /home/fake/.codex/memories/MEMORY.md", 'searching "ref19|video|видео"'],
    ['ls /home/fake/tmp/bakeoff/p2/scan2 | tail -6\nps -ax -o pid,command | rg \'ffmpeg|python3 -\' | head -8', 'listing scan2 +1'],
    ["which -a python3 uv magick montage; ls -d /tmp/*venv* 2>/dev/null", 'listing *venv*'],
    ["/usr/bin/python3 -c 'from PIL import Image; print(\"pillow ok\")'", 'running a Python one-liner'],
    ['cd /home/fake/proj && npm run gate 2>&1 | tail -20', 'npm run gate'],
    ['DATABASE_URL=postgres://u:pw@db/x pnpm vitest run apps/core', 'pnpm vitest run'],
    ['git status --short && git diff --stat', 'git status +1'],
    ['pwd', 'pwd'],
    ["timeout 30 node tools/bench_ride.ts --map pit_v1", 'running bench_ride.ts'],
  ]
  for (const [cmd, want] of cases) {
    test(want, () => {
      expect(describeCommand(cmd)).toBe(want)
    })
  }

  test("Codex's own parsed_cmd wins when every part is a read, list or search", () => {
    expect(describeCommand('cat .claude/skills/playtest-video/SKILL.md', [{ type: 'read', name: 'SKILL.md', path: '.claude/skills/playtest-video/SKILL.md' }])).toBe('reading SKILL.md')
    expect(describeCommand('ls x', [{ type: 'list_files', path: 'scan2' }])).toBe('listing scan2')
    expect(describeCommand("pwd && cat CLAUDE.md", [{ type: 'unknown', cmd: 'pwd && cat CLAUDE.md' }])).toBe('reading CLAUDE.md')
  })

  test('a code-mode exec call without a shell command: what tool it calls', () => {
    expect(describeJs('const r=await tools.view_image({path:"/home/fake/tmp/p2/shots/A01/sheet_00.jpg",detail:"original"});image(r.image_url);', undefined)).toBe('viewing A01/sheet_00.jpg')
    expect(describeJs('text(await tools.write_stdin({session_id:62717,chars:"",yield_time_ms:1000}));', undefined)).toBe('waiting on a running command')
  })
})

describe('an agent remark as its first sentence', () => {
  test('list mark, bold and code marks go; the first sentence stays', () => {
    expect(noteLine('- Разберу очереди по кадрам: отдельно отмечу отрыв. Репозиторий не трогаю; кадры запишу в out.\nвторая')).toBe('Разберу очереди по кадрам: отдельно отмечу отрыв.')
    expect(noteLine('**Готово.** Тесты `npm test` зелёные')).toBe('Готово. Тесты npm test зелёные')
    expect(noteLine('\n\n')).toBeUndefined()
  })
})

describe('names from the process list', () => {
  test('the -o stem', () => {
    expect(stemOf('codex exec -m gpt-6.1-sol -o /home/fake/out/p2_scan1.last.txt # Pass 2b')).toBe('p2_scan1')
    expect(stemOf('codex exec --output-last-message=/tmp/answer2.txt hi')).toBe('answer2')
    expect(stemOf('codex exec -m gpt-6.1-sol hi')).toBeNull()
  })

  test('the native binary of a codex exec, not its node launcher or another codex command', () => {
    expect(codexProc(' 68390 68378 /home/fake/.nvm/lib/node_modules/@openai/codex/vendor/bin/codex exec -m x -o /t/a.txt hi')).toEqual({ pid: 68390, ppid: 68378, args: '/home/fake/.nvm/lib/node_modules/@openai/codex/vendor/bin/codex exec -m x -o /t/a.txt hi' })
    expect(codexProc(' 68378 900 node /home/fake/.nvm/bin/codex exec -m x -o /t/a.txt hi')).toBeNull()
    expect(codexProc(' 12 1 /usr/local/bin/codex app-server')).toBeNull()
    expect(codexProc('continuation of a prompt line')).toBeNull()
  })

  test('lsof -Fpn: the rollout each pid holds', () => {
    const out = 'p68390\nn/dev/null\nn/home/fake/.codex/sessions/2026/10/29/rollout-2026-10-29T08-20-52-01a18688-7041-7e33-aae1-e4a37cff3849.jsonl\np84639\nn/tmp/x'
    expect([...lsofThreads(out)]).toEqual([[68390, '01a18688-7041-7e33-aae1-e4a37cff3849']])
  })

  test('a long heading is cut at a word, a dangling bracket dropped', () => {
    expect(clipWords('Pass 2b: a complete list of vertical events, small bumps, wall hits and turns (original SmashKarts)', 80)).toBe('Pass 2b: a complete list of vertical events, small bumps, wall hits and turns…')
    expect(clipWords('short', 80)).toBe('short')
  })
})

describe('describeCommand never shows a secret', () => {
  const secrets = ['hunter2secretvalue', 'Zq9xK2mP7vL4', 'sk-live-abcdefghijklmnop']
  const cmds = [
    'curl -H "Authorization: Bearer Zq9xK2mP7vL4abcd" https://api.example.com/v1',
    'mytool --api-key hunter2secretvalue run',
    'mytool --key hunter2secretvalue',
    'mytool hunter2secretvalue',
    'gh --token Zq9xK2mP7vL4 pr list',
    'docker login -p hunter2secretvalue registry.example.com',
    'npm --registry-token Zq9xK2mP7vL4 publish',
    'npx some-cli Zq9xK2mP7vL4',
    'TOKEN=sk-live-abcdefghijklmnop node build.js',
    'deploy https://user:hunter2secretvalue@host.example.com/x',
    'fetcher https://host.example.com/a.json?token=Zq9xK2mP7vL4',
  ]
  for (const cmd of cmds) {
    test(cmd, () => {
      const out = describeCommand(cmd) ?? ''
      for (const s of secrets) expect(out).not.toContain(s)
    })
  }

  test('keeps the useful words', () => {
    expect(describeCommand('npm run gate')).toBe('npm run gate')
    expect(describeCommand('gh --repo me/x pr view')).toBe('gh pr view')
    expect(describeCommand('mytool build/out.json')).toBe('mytool out.json')
  })
})
