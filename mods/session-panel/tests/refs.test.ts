import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { emptyPanel, taskRegex } from '../hooks/logic'
import { plain, runs } from '../hooks/markup'
import type { Run } from '../hooks/markup'
import { blocked, candidates, executable, gate, githubRepo, linked, placeByName, repoOfLinks } from '../hooks/refs'
import type { Places } from '../hooks/refs'
import type { Panel } from '../types'

const REPO = 'https://github.com/acme/app'
// The owner's own line: a PR named by its number inside Cyrillic text with «» quotes.
const MICRO_PR =
  'Микро-PR #140 «все as const словари → TS enum» открыт: 19 наборов, значения в ответах API те же, CI зелёный; вливать squash-ом после #139 от сессии coder.'
// A commit and a job id look the same; only git tells them apart.
const SHA_LINE = 'PH-95 fix + PH-96/97 deployed together 04.10 (`d658d491`), ID для respawn: coder — `549ced52`'
const CARD = 'obsidian://open?vault=v&file=proj%2Ftasks%2FPH-95'

const AT: Places = {
  repo: REPO,
  commits: ['d658d491'],
  files: {
    '/home/fake/proj/hooks/markup.ts': { abs: '/home/fake/proj/hooks/markup.ts', dir: false },
    'hooks/refs.ts': { abs: '/home/fake/proj/hooks/refs.ts', dir: false },
    '~/claude-code-kit/mods': { abs: '/home/fake/claude-code-kit/mods', dir: true },
    '/Applications/Calc.app': { abs: '/Applications/Calc.app', dir: true },
  },
  cards: new Map([['PH-95', CARD]]),
  task: taskRegex(undefined),
}

const links = (list: Run[]) => list.filter(r => r.href !== undefined).map(r => [r.text, r.href])
const draw = (text: string, at: Places = AT) => linked(runs(text), at)

describe('every place a line names is a link where it stands', () => {
  test('#140 and #139 in Cyrillic text with «» quotes lead to the repo, the text around them unchanged', () => {
    const out = draw(MICRO_PR)
    expect(links(out)).toEqual([
      ['#140', `${REPO}/issues/140`],
      ['#139', `${REPO}/issues/139`],
    ])
    expect(out.map(r => r.text).join('')).toBe(MICRO_PR)
  })

  test('a sha git knows is a commit link and keeps its code colour; a job id and PH-96/97 stay text; the task links its card', () => {
    const out = draw(SHA_LINE)
    expect(links(out)).toEqual([
      ['PH-95', CARD],
      ['d658d491', `${REPO}/commit/d658d491`],
    ])
    expect(out.find(r => r.text === 'd658d491')?.code).toBe(true)
    expect(out.find(r => r.text.includes('549ced52'))?.href).toBeUndefined()
  })

  test('an address keeps its sentence full stop outside the link; a bare address and a markdown one both link', () => {
    const out = draw('стенд https://stand.example.com/products. И доска [PH-95 доска](obsidian://open?vault=v&file=b).')
    expect(links(out)).toEqual([
      ['https://stand.example.com/products', 'https://stand.example.com/products'],
      ['PH-95 доска', 'obsidian://open?vault=v&file=b'],
    ])
    expect(out.find(r => r.text.startsWith('. И доска'))).toBeDefined()
  })

  test('a file opens in the IDE at its line, a folder in Finder, an app bundle not at all, a missing path stays text', () => {
    const out = draw('правка в /home/fake/proj/hooks/markup.ts:42 и hooks/refs.ts. Мод в ~/claude-code-kit/mods, не /Applications/Calc.app и не apps/gone.ts')
    expect(links(out)).toEqual([
      ['/home/fake/proj/hooks/markup.ts:42', 'webstorm://open?file=/home/fake/proj/hooks/markup.ts&line=42'],
      ['hooks/refs.ts', 'webstorm://open?file=/home/fake/proj/hooks/refs.ts'],
      ['~/claude-code-kit/mods', 'file:///home/fake/claude-code-kit/mods/'],
    ])
  })

  test('a markdown link into the IDE to a checked file links, rebuilt from the check; its file is a candidate too', () => {
    const line = 'Дебет без транзакции — [markup.ts:290](webstorm://open?file=/home/fake/proj/hooks/markup.ts&line=290)'
    expect(candidates(line).paths).toEqual(['/home/fake/proj/hooks/markup.ts'])
    expect(links(draw(line))).toEqual([['markup.ts:290', 'webstorm://open?file=/home/fake/proj/hooks/markup.ts&line=290']])
  })

  test('without a known repo #N and shas stay text; another repo named with its number still links', () => {
    const out = draw('PR #140 и acme/other#12, коммит d658d491', { ...AT, repo: '' })
    expect(links(out)).toEqual([['acme/other#12', 'https://github.com/acme/other/issues/12']])
  })

  test('a UUID part, a plain number and a hex word are no sha candidates; a lone hex with digits is', () => {
    expect(candidates('сессия 4daf0ac6-6001-45fa, 1234567 строк, defaced, kit 74c9268.').shas).toEqual(['74c9268'])
  })

  test('every path candidate, once found on disk, is linked as exactly the text it was read from', () => {
    const lines = [MICRO_PR, SHA_LINE, 'см. hooks/refs.ts:12, /home/fake/a b/c.md и ~/x/y.', 'brain/tasks/PH-95.md; apps/web/src/main.tsx']
    for (const line of lines) {
      const text = plain(line)
      const found = candidates(text).paths
      const files = Object.fromEntries(found.map(p => [p, { abs: `/abs/${p}`, dir: false }]))
      const out = linked(runs(line), { ...AT, files })
      const linkedPaths = out.filter(r => r.href?.startsWith('webstorm://')).map(r => r.text.replace(/:\d+$/, ''))
      expect(linkedPaths).toEqual(found)
      expect(out.map(r => r.text).join('')).toBe(text)
    }
  })

  test('the repo comes from an ssh or https remote, or from the panel links when the folder is no repo', () => {
    expect(githubRepo('git@github.com:acme/app.git\n')).toBe(REPO)
    expect(githubRepo('https://github.com/acme/app.git')).toBe(REPO)
    expect(githubRepo('https://gitlab.com/acme/app.git')).toBe('')
    expect(repoOfLinks([`${REPO}/pull/41`, `${REPO}/pull/42`, 'https://github.com/x/y/pull/1', 'https://example.com'])).toBe(REPO)
  })
})

describe('one gate for every address: what fails it draws as plain text', () => {
  // Each line is a hole the text could open; every one must draw with no link at all.
  const HOLES = [
    '[x](javascript:alert(1))',
    '[Calc](file:///Applications/Calc.app) и file:///Applications/Calc.app',
    '[проект](jetbrains://idea/navigate/reference?project=a&path=b)',
    '[passwd](webstorm://open?file=/etc/passwd) и webstorm://open?file=/etc/passwd',
    '[markup](webstorm://open?file=/home/fake/proj/hooks/markup.ts&line=1&run=1)',
    '[cmd](obsidian://advanced-uri?vault=v&commandid=x) и obsidian://advanced-uri?commandid=x',
    'x-apple.systempreferences:com.apple.preference и vscode://file/etc/passwd и [s](ssh://host)',
    'приложение /Applications/Calc.app и ~/claude-code-kit/mods/x.app/Contents/MacOS/x',
  ]
  test('a crafted line per hole links nothing', () => {
    const at: Places = {
      ...AT,
      files: { ...AT.files, '~/claude-code-kit/mods/x.app/Contents/MacOS/x': { abs: '/home/fake/claude-code-kit/mods/x.app/Contents/MacOS/x', dir: false } },
    }
    for (const line of HOLES) expect([line, links(draw(line, at))]).toEqual([line, []])
  })

  test('the web and the vault open pass; a task card behind an unsafe address stays text', () => {
    expect(gate('https://example.com/a', {})).toBe('https://example.com/a')
    expect(gate('http://localhost:3000/x', {})).toBe('http://localhost:3000/x')
    expect(gate('obsidian://open?vault=v&file=b', {})).toBe('obsidian://open?vault=v&file=b')
    expect(links(draw('PH-95 готово', { ...AT, cards: new Map([['PH-95', 'obsidian://advanced-uri?commandid=x']]) }))).toEqual([])
  })

  test('a path is placed by spelling inside a root before the disk is asked; dots and other places are refused', () => {
    const roots = ['/home/fake/proj', '/home/fake/vault']
    expect(placeByName('hooks/refs.ts', ['/home/fake/proj'], '/home/fake', roots)).toEqual(['/home/fake/proj/hooks/refs.ts'])
    expect(placeByName('../../etc/passwd', ['/home/fake/proj'], '/home/fake', roots)).toEqual([])
    expect(placeByName('/home/fake/proj/../.ssh/id_rsa', [], '/home/fake', roots)).toEqual([])
    expect(placeByName('/net/evil.example/share/x', [], '/home/fake', roots)).toEqual([])
    expect(placeByName('/home/fake/projector/x', [], '/home/fake', roots)).toEqual([])
    expect(placeByName('~/vault/PH-95.md', [], '/home/fake', roots)).toEqual(['/home/fake/vault/PH-95.md'])
  })

  test('bundles anywhere on the path and files a launcher runs are blocked; an execute bit counts as runnable', () => {
    for (const p of ['/a/Calc.app', '/a/Calc.app/Contents/MacOS/Calc', '/a/x.workflow', '/a/x.prefPane']) expect([p, blocked(p, true)]).toEqual([p, true])
    for (const p of ['/a/run.command', '/a/deploy.sh', '/a/x.webloc', '/a/x.dmg', '/a/x.pkg', '/a/x.terminal', '/a/x.fileloc', '/a/x.inetloc', '/a/x.tool']) {
      expect([p, blocked(p, false)]).toEqual([p, true])
    }
    expect(blocked('/a/docs/design.md', false)).toBe(false)
    expect(blocked('/a/src', true)).toBe(false)
    expect(executable('100755')).toBe(true)
    expect(executable('100644')).toBe(false)
    expect(executable('junk')).toBe(true)
  })
})

const SID = 'sess-1'
const PANE = { plugin: 'session-panel', component: 'Pane', requestId: 'session-panel', props: { title: 'Сессия', isFocused: true, bodyColumns: 48, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} } } as const

type Calls = { git: string[][]; stats: string[] }

function world(on: On, panel: Panel): Calls {
  const calls: Calls = { git: [], stats: [] }
  const store = new Map<string, unknown>([[`panel:${SID}`, panel]])
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  mock.clock(on, { now: 1_000 })
  mock.env(on, { HOME: '/home/fake' })
  on('session.id', () => ({ value: SID }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__session-panel__${e.name}` } }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { opened: true } }) as never)
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.repo', () => ({ value: { root: '/home/fake/proj', remote: 'git@github.com:acme/app.git', internal: false, name: null } }))
  on('process.run', (_$, e) => {
    calls.git.push([...e.argv])
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const args = e.argv.slice(1).join(' ')
    if (e.argv[0] === '/usr/bin/stat') {
      const files = e.argv.slice(e.argv.indexOf('--') + 1)
      return ok(files.map(f => `${f.endsWith('/bin/run') ? '100755' : '100644'}\t${f}`).join('\n') + '\n')
    }
    if (args === 'cat-file --batch-check') {
      const asked = (e.init?.stdin ?? '').split('\n').filter(Boolean)
      return ok(asked.map(a => (a.startsWith('d658d491') ? 'd658d4910000 commit 250' : `${a} missing`)).join('\n') + '\n')
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'unknown', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  // What is on the fake disk: a file, an executable, a link out of the project, a folder, and a file outside every root.
  const disk: Record<string, { kind: 'file' | 'dir'; realPath: string; isLink?: boolean }> = {
    '/home/fake/proj': { kind: 'dir', realPath: '/home/fake/proj' },
    '/home/fake/proj/hooks/refs.ts': { kind: 'file', realPath: '/home/fake/proj/hooks/refs.ts' },
    '/home/fake/proj/bin/run': { kind: 'file', realPath: '/home/fake/proj/bin/run' },
    '/home/fake/proj/docs/out.md': { kind: 'file', realPath: '/etc/hosts', isLink: true },
    '/home/fake/proj/docs': { kind: 'dir', realPath: '/home/fake/proj/docs' },
    '/home/fake/other/x.ts': { kind: 'file', realPath: '/home/fake/other/x.ts' },
  }
  on('fs.stat', (_$, e) => {
    calls.stats.push(e.path)
    const f = disk[e.path]
    return f === undefined
      ? { deny: `ENOENT ${e.path}` }
      : { value: { kind: f.kind, size: 1, mtimeMs: 0, isLink: f.isLink === true, ...(e.resolve ? { realPath: f.realPath } : {}) } }
  })
  return calls
}

const start = ($: Engine) => $.session.start({ cwd: '/home/fake/proj', surface: 'terminal', isInteractive: true })

describe('the pane links in place', () => {
  const STORED: Panel = {
    ...emptyPanel(1_000),
    seq: 3,
    items: [
      { id: 'i1', kind: 'link', text: 'PR #139', href: `${REPO}/pull/139`, checked: false, by: 'auto' },
      { id: 'i2', kind: 'done', text: MICRO_PR, checked: true, by: 'auto' },
      { id: 'i3', kind: 'done', text: `${SHA_LINE}; правка в hooks/refs.ts`, checked: true, by: 'auto' },
      { id: 'i4', kind: 'done', text: 'скрипт bin/run, заметка docs/out.md, папка /home/fake/proj/docs, чужое /home/fake/other/x.ts и /net/evil.example/share/x', checked: true, by: 'auto' },
      { id: 'i5', kind: 'link', text: 'команда', href: 'obsidian://advanced-uri?commandid=x', checked: false, by: 'tool' },
    ],
  }

  test('a stored result line links #140 to the session repo, a real commit, a real file; a job id stays text', async ($, on) => {
    const calls = world(on, STORED)
    await start($)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    await ui.drawn()
    // A drawn Link's text in the test engine is its href followed by its label.
    const href = async (text: string) => (await ui.findAll({ type: 'Link' })).find(l => l.text === `${String(l.props.href)}${text}`)?.props.href
    expect(await href('#140')).toBe(`${REPO}/issues/140`)
    expect(await href('d658d491')).toBe(`${REPO}/commit/d658d491`)
    expect(await href('hooks/refs.ts')).toBe('webstorm://open?file=/home/fake/proj/hooks/refs.ts')
    expect(await href('549ced52')).toBeUndefined()
    // The links section stays as it was, behind the same gate.
    expect(await href('PR #139')).toBe(`${REPO}/pull/139`)
    expect(await href('команда')).toBeUndefined()
    expect((await ui.findAll({ type: 'Text' })).some(t => t.text === 'команда')).toBe(true)
    // An executable and a link out of every root stay text; a folder opens in Finder.
    expect(await href('bin/run')).toBeUndefined()
    expect(await href('docs/out.md')).toBeUndefined()
    expect(await href('/home/fake/proj/docs')).toBe('file:///home/fake/proj/docs/')
    // A path spelt outside every root is never asked about on disk.
    expect(calls.stats.some(p => p.includes('/other/') || p.startsWith('/net/'))).toBe(false)
    // Git is asked once for both shas, the disk once per path.
    expect(calls.git.filter(a => a.includes('cat-file')).length).toBe(1)
    await ui.unmount()
  })
})
