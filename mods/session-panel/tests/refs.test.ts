import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { emptyPanel, taskRegex } from '../hooks/logic'
import { plain, runs } from '../hooks/markup'
import type { Run } from '../hooks/markup'
import { candidates, githubRepo, linked, repoOfLinks } from '../hooks/refs'
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
      ['~/claude-code-kit/mods', 'file:///home/fake/claude-code-kit/mods'],
    ])
  })

  test('a markdown link into the IDE draws as its label, not raw', () => {
    const out = runs('Дебет без транзакции — [bonus.ts:290](webstorm://open?file=/a/bonus.ts&line=290)')
    expect(links(out)).toEqual([['bonus.ts:290', 'webstorm://open?file=/a/bonus.ts&line=290']])
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
  on('process.run', (_$, e) => {
    calls.git.push([...e.argv])
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const args = e.argv.slice(1).join(' ')
    if (args === 'rev-parse --show-toplevel') return ok('/home/fake/proj\n')
    if (args === 'remote get-url origin') return ok('git@github.com:acme/app.git\n')
    if (args === 'cat-file --batch-check') {
      const asked = (e.init?.stdin ?? '').split('\n').filter(Boolean)
      return ok(asked.map(a => (a.startsWith('d658d491') ? 'd658d4910000 commit 250' : `${a} missing`)).join('\n') + '\n')
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'unknown', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', (_$, e) => {
    calls.stats.push(e.path)
    return e.path === '/home/fake/proj/hooks/refs.ts' ? { value: { kind: 'file', size: 1, mtimeMs: 0, isLink: false } } : { deny: `ENOENT ${e.path}` }
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
    // The links section stays as it was.
    expect(await href('PR #139')).toBe(`${REPO}/pull/139`)
    // Git is asked once for both shas, the disk once per path.
    expect(calls.git.filter(a => a.includes('cat-file')).length).toBe(1)
    await ui.unmount()
  })
})
