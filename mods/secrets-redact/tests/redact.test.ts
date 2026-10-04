import type { On, SessionAppendResult, ToolCallResult } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import { ACCESS_MD, CLEAN, ENV_EXAMPLE, ENV_FILE, FAKE, LEAKS, PROC_ENV, ZSHENV } from './fixtures'
import { EMPTY_INDEX, buildIndex, hasPlaceholder, isKnownCandidate, placeholder, redactText } from '../hooks/redact'

const HOME = '/home/fake'
const PROJ = '/work/proj'
const ACCESS = '/notes/access.md'
const T0 = Date.UTC(2026, 9, 4, 8, 0)

type File = { text: string; mtimeMs: number }
type Core = (e: Record<string, unknown>) => ToolCallResult
type World = {
  files: Map<string, File>
  dirs: Set<string>
  /** What the engine's tool answers, per call; the default echoes `stdout`. */
  core: Core
  stdout: string
  ran: string[]
  rows: SessionAppendResult['message'][]
  logs: string[]
  runs: number
  clock: MockClock
  /** Status-line texts the plugin set. */
  status: (string | undefined)[]
  /** Delivery texts as session.receive handed them to the bottom. */
  received: string[]
  /** Prompt texts and context as prompt.submit handed them to the bottom. */
  submitted: { text: string; context?: readonly string[] }[]
  /** Whether `env -0` succeeds. */
  procOk: boolean
  /** Reads of a path that fail before it reads again. */
  readFails: Map<string, number>
  /** What `$.session.id()` answers; a /clear changes it without a new session.start. */
  sessionId: string
}

/** A placeholder with its session nonce taken out, so assertions read as the bare form. */
const norm = (s: string | undefined): string => String(s ?? '').replace(/#[0-9a-f]{4}›/g, '›')
/** The first placeholder (nonce and all) in a text the mod produced. */
const firstMark = (s: string): string => /‹secret:[^›\s]+›/.exec(s)?.[0] ?? ''

/** The world beneath the plugin: env, session dirs, an in-memory file system, the process env, the tools. */
function world(on: On, opts: { env?: Record<string, string> } = {}): World {
  const w: World = {
    files: new Map([
      [`${PROJ}/.env`, { text: ENV_FILE, mtimeMs: T0 }],
      [`${PROJ}/.env.example`, { text: ENV_EXAMPLE, mtimeMs: T0 }],
      [`${PROJ}/README.md`, { text: '# proj', mtimeMs: T0 }],
      [`${HOME}/.zshenv`, { text: ZSHENV, mtimeMs: T0 }],
      [ACCESS, { text: ACCESS_MD, mtimeMs: T0 }],
    ]),
    dirs: new Set([PROJ, `${PROJ}/.git`, `${PROJ}/src`, HOME, `${HOME}/.ssh`, '/notes']),
    core: e => ({ result: { stdout: w.stdout, stderr: '', interrupted: false } }) as never,
    stdout: '',
    ran: [],
    rows: [],
    logs: [],
    runs: 0,
    clock: mock.clock(on, { now: T0 }),
    status: [],
    received: [],
    submitted: [],
    procOk: true,
    readFails: new Map(),
    sessionId: 'sess-1',
  }
  mock.env(on, { HOME, ...opts.env })
  on('session.root', () => ({ value: PROJ }))
  on('session.cwd', () => ({ value: PROJ }))
  on('session.id', () => ({ value: w.sessionId }))
  on('fs.write', (_$, e) => {
    w.files.set(e.path, { text: e.text, mtimeMs: T0 })
    return { value: undefined } as never
  })
  on('ui.log', (_$, e) => {
    w.logs.push(String((e as { text?: unknown }).text ?? ''))
    return { value: undefined } as never
  })
  on('ui.status', (_$, e) => {
    w.status.push((e as { text?: string }).text)
    return { value: undefined } as never
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$, e) => {
    w.submitted.push({ text: e.text, ...(e.context && { context: e.context }) })
    return { text: e.text, ...(e.context && { context: e.context }) }
  })
  on('session.receive', (_$, e) => {
    w.received.push(e.text)
    return { text: e.text }
  })
  on('fs.exists', (_$, e) => ({ value: w.files.has(e.path) || w.dirs.has(e.path) }))
  on('fs.stat', (_$, e) => {
    const f = w.files.get(e.path)
    if (f !== undefined) return { value: { kind: 'file' as const, size: f.text.length, mtimeMs: f.mtimeMs, isLink: false } }
    if (w.dirs.has(e.path)) return { value: { kind: 'dir' as const, size: 0, mtimeMs: dirMtime(w, e.path), isLink: false } }
    return { deny: `ENOENT ${e.path}` }
  })
  on('fs.list', (_$, e) => {
    if (!w.dirs.has(e.path)) return { deny: `ENOENT ${e.path}` }
    const prefix = e.path.endsWith('/') ? e.path : `${e.path}/`
    const names = new Map<string, 'file' | 'dir'>()
    for (const p of w.files.keys()) if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) names.set(p.slice(prefix.length), 'file')
    for (const d of w.dirs) if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) names.set(d.slice(prefix.length), 'dir')
    return {
      value: [...names].map(([name, kind]) => ({ name, kind, size: kind === 'file' ? w.files.get(prefix + name)!.text.length : 0, mtimeMs: kind === 'file' ? w.files.get(prefix + name)!.mtimeMs : 0, isLink: false })),
    }
  })
  on('fs.read', (_$, e) => {
    const left = w.readFails.get(e.path) ?? 0
    if (left > 0) {
      w.readFails.set(e.path, left - 1)
      return { deny: `EIO ${e.path}` }
    }
    const f = w.files.get(e.path)
    return f === undefined ? { deny: `ENOENT ${e.path}` } : { value: f.text }
  })
  on('process.run', (_$, e) => {
    w.runs += 1
    if (e.argv.join(' ') !== '/usr/bin/env -0') return { deny: `unexpected process ${e.argv.join(' ')}` }
    if (!w.procOk) return { value: { exitCode: 1, stdout: '', stderr: 'env: illegal option -- 0', isStdoutTruncated: false, isStderrTruncated: false } }
    return { value: { exitCode: 0, stdout: PROC_ENV, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('tool.call', (_$, e) => {
    w.ran.push(String(e.tool))
    return w.core(e as unknown as Record<string, unknown>)
  })
  // The row as the plugins hand it down. Nothing beneath a test keeps rows, and a
  // session.append hook must relay next(e), so the call rejects after this saw it.
  on('session.append', (_$, e, next) => {
    w.rows.push(e.message)
    return next(e)
  })
  return w
}

/** A directory's mtime follows its newest file, as a real one does when a file is added. */
function dirMtime(w: World, dir: string): number {
  let m = T0
  for (const [p, f] of w.files) if (p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')) m = Math.max(m, f.mtimeMs)
  return m
}

/** Appends a row through the plugins; the bottom has no row store, so its refusal is expected and dropped. */
const append = async ($: Engine, row: unknown) => {
  await $.session.append(row as never).catch((err: unknown) => {
    if (!String(err).includes('no implementation for session.append')) throw err
  })
}

const bash = async ($: Engine, w: World, stdout: string, command = 'cat .env') => {
  w.stdout = stdout
  return $.tool.call({ tool: 'Bash', command })
}
const stdoutOf = (r: ToolCallResult): string => String((r.result as { stdout?: unknown } | undefined)?.stdout ?? '')

const readRecord = (filePath: string, content: string) => ({
  result: { type: 'text', file: { filePath, content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length } },
})
const contentOf = (r: ToolCallResult): string => String((r.result as { file?: { content?: unknown } } | undefined)?.file?.content ?? '')

describe('leaks are hidden, names stay', () => {
  test('every fixture leak, as Bash output, comes back with its values replaced', { timeoutMs: 20_000, options: { extraFiles: [ACCESS] } }, async ($, on) => {
    const w = world(on)
    for (const c of LEAKS) {
      const out = stdoutOf(await bash($, w, c.text))
      for (const h of c.hide) expect({ case: c.name, leaked: out.includes(h) }).toEqual({ case: c.name, leaked: false })
      for (const k of c.keep ?? []) expect({ case: c.name, kept: out.includes(k) }).toEqual({ case: c.name, kept: true })
      expect({ case: c.name, marked: out.includes('‹secret:') }).toEqual({ case: c.name, marked: true })
    }
    expect(w.logs).toEqual([])
  })

  test('cat .env names each hidden value by its variable', async ($, on) => {
    const w = world(on)
    const out = norm(stdoutOf(await bash($, w, ENV_FILE)))
    expect(out).toContain('DB_PASSWORD=‹secret:DB_PASSWORD›')
    expect(out).toContain('TELEGRAM_BOT_TOKEN=‹secret:TELEGRAM_BOT_TOKEN›')
    expect(out).toContain('GMAIL_APP_PASSWORD="‹secret:GMAIL_APP_PASSWORD›"')
    expect(out).toContain('DATABASE_URL=postgres://acme:‹secret:DATABASE_URL›@127.0.0.1:5435/acme')
    expect(out).toContain('NODE_ENV=development')
  })

  test('a known value printed bare (node -e, echo $X) is hidden: .env, ~/.zshenv, the process env', async ($, on) => {
    const w = world(on)
    expect(norm(stdoutOf(await bash($, w, `${FAKE.dbPassword}\n`, 'node -e "console.log(process.env.DB_PASSWORD)"')))).toBe('‹secret:DB_PASSWORD›\n')
    expect(norm(stdoutOf(await bash($, w, `${FAKE.zshKey}\n`, 'echo $GEMINI_API_KEY')))).toBe('‹secret:GEMINI_API_KEY›\n')
    expect(norm(stdoutOf(await bash($, w, `${FAKE.envOnly}\n`, 'echo $MY_SERVICE_PASSWORD')))).toBe('‹secret:MY_SERVICE_PASSWORD›\n')
    expect(w.runs).toBe(1)
  })

  test('Read of the .env: values hidden in the file record, names and plain settings kept', async ($, on) => {
    const w = world(on)
    w.core = e => readRecord(String(e.file_path), ENV_FILE) as never
    const r = await $.tool.call({ tool: 'Read', file_path: `${PROJ}/.env` })
    const content = norm(contentOf(r))
    for (const v of [FAKE.dbPassword, FAKE.gmailApp, FAKE.telegram, FAKE.openai, FAKE.sessionSecret, FAKE.urlPassword]) expect(content).not.toContain(v)
    expect(content).toContain('DB_PASSWORD=‹secret:DB_PASSWORD›')
    expect(content).toContain('PORT=3000')
    expect((r.result as { file: { filePath: string } }).file.filePath).toBe(`${PROJ}/.env`)
  })

  test('Read of a credential file: the whole content gives way to a notice', async ($, on) => {
    const w = world(on)
    w.core = e => readRecord(String(e.file_path), `${FAKE.pem}\n`) as never
    const content = contentOf(await $.tool.call({ tool: 'Read', file_path: `${HOME}/.ssh/id_ed25519` }))
    expect(content).not.toContain('PRIVATE KEY')
    expect(content).not.toContain(FAKE.pem.split('\n')[1]!)
    expect(content).toContain('id_ed25519')

    w.core = e => readRecord(String(e.file_path), JSON.stringify({ claudeAiOauth: { accessToken: FAKE.oauthAccess } })) as never
    const cred = contentOf(await $.tool.call({ tool: 'Read', file_path: `${HOME}/.claude/.credentials.json` }))
    expect(cred).not.toContain(FAKE.oauthAccess)
  })

  test('an MCP text result carrying a GitHub token is hidden, structure kept', async ($, on) => {
    const w = world(on)
    const mcp = { content: [{ type: 'text', text: `config: token=${FAKE.ghToken}\nrepo: Shopco/acme` }], isError: false }
    w.core = () => ({ result: mcp }) as never
    const r = await $.tool.call({ tool: 'mcp__github__get_file_contents', tool_use_id: 'toolu_mcp1', path: 'x' } as never)
    const text = (r.result as typeof mcp).content[0]!.text
    expect(text).not.toContain(FAKE.ghToken)
    expect(text).toContain('repo: Shopco/acme')
    expect((r.result as typeof mcp).content[0]!.type).toBe('text')
  })

  test('an errored Bash call (non-zero exit) carrying a secret comes back as a deny with the redacted text', async ($, on) => {
    const w = world(on)
    const raw = `Exit code 1\nDB_PASSWORD=${FAKE.dbPassword}\nerror: connection refused`
    w.core = () => ({ isError: true, result: raw, text: raw }) as never
    const r = await $.tool.call({ tool: 'Bash', command: 'cat .env; false' })
    // a hook's own isError answer is checked against Bash's output schema and refused live,
    // so the redacted error text travels as a deny, which the model reads as an error result
    expect(typeof r.deny).toBe('string')
    expect(r.deny).not.toContain(FAKE.dbPassword)
    expect(norm(r.deny)).toContain('DB_PASSWORD=‹secret:DB_PASSWORD›')
    expect(r.deny).toContain('error: connection refused')
  })

  test('an errored Bash call with no secret is core answer untouched', async ($, on) => {
    const w = world(on)
    const raw = 'Exit code 3\nno such file'
    const given = { isError: true, result: raw, text: raw }
    w.core = () => given as never
    const r = await $.tool.call({ tool: 'Bash', command: 'cat nope' })
    expect(r.isError).toBe(true)
    expect(r.deny).toBeUndefined()
    expect(r.text).toBe(raw)
  })

  test('a reminder the tool attached (context) is relayed as is: core refuses a hook that drops one, the backstop hides its row', async ($, on) => {
    const w = world(on)
    w.core = () => ({ result: { stdout: `x ${FAKE.telegram}`, stderr: '', interrupted: false }, context: ['note: file changed'] }) as never
    const r = await $.tool.call({ tool: 'Bash', command: 'x' })
    expect(r.context).toEqual(['note: file changed'])
    expect(stdoutOf(r)).not.toContain(FAKE.telegram)
  })

  test('extraFiles: values from an access note count as known', { options: { extraFiles: [ACCESS] } }, async ($, on) => {
    const w = world(on)
    expect(norm(stdoutOf(await bash($, w, `admin pass is ${FAKE.accessMd} ok`, 'echo')))).toBe('admin pass is ‹secret:ADMIN_PASSWORD› ok')
  })

  test('without extraFiles the access note is not read', async ($, on) => {
    const w = world(on)
    expect(stdoutOf(await bash($, w, `admin pass is ${FAKE.accessMd} ok`, 'echo'))).toBe(`admin pass is ${FAKE.accessMd} ok`)
  })

  test('an edited .env is picked up after the refresh interval', async ($, on) => {
    const w = world(on)
    const fresh = 'Fr3sh-Rotated-Value-77'
    await bash($, w, 'warm')
    w.files.set(`${PROJ}/.env`, { text: `${ENV_FILE}ROTATED_TOKEN=${fresh}\n`, mtimeMs: T0 + 60_000 })
    await w.clock.advance(2_500)
    expect(norm(stdoutOf(await bash($, w, `got ${fresh}`, 'echo')))).toBe('got ‹secret:ROTATED_TOKEN›')
  })

  test('a new .env.local in the project is found once the directory changes', async ($, on) => {
    const w = world(on)
    const local = 'L0cal-Only-Secret-55'
    await bash($, w, 'warm')
    w.files.set(`${PROJ}/.env.local`, { text: `LOCAL_API_KEY=${local}\n`, mtimeMs: T0 + 90_000 })
    await w.clock.advance(2_500)
    expect(norm(stdoutOf(await bash($, w, local, 'echo')))).toBe('‹secret:LOCAL_API_KEY›')
  })
})

describe('no-op: nothing secret, nothing changed', () => {
  test('every clean fixture comes back as given', { timeoutMs: 20_000, options: { extraFiles: [ACCESS] } }, async ($, on) => {
    const w = world(on)
    for (const c of CLEAN) expect({ case: c.name, out: stdoutOf(await bash($, w, c.text, 'x')) }).toEqual({ case: c.name, out: c.text })
  })

  test('an untouched result is the engine\'s own answer, relayed as is', async ($, on) => {
    const w = world(on)
    const answer = { result: { stdout: 'total 0\n-rw------- 1 u s 376 .env\n', stderr: '', interrupted: false } }
    w.core = () => answer as never
    const r = await $.tool.call({ tool: 'Bash', command: 'ls -la .env' })
    expect(r.result).toEqual(answer.result)
  })

  test('Read of .env.example and of source code is untouched', async ($, on) => {
    const w = world(on)
    w.core = e => readRecord(String(e.file_path), ENV_EXAMPLE) as never
    expect(contentOf(await $.tool.call({ tool: 'Read', file_path: `${PROJ}/.env.example` }))).toBe(ENV_EXAMPLE)
    const code = CLEAN.find(c => c.name.startsWith('TS code'))!.text
    w.core = e => readRecord(String(e.file_path), code) as never
    expect(contentOf(await $.tool.call({ tool: 'Read', file_path: `${PROJ}/src/auth.ts` }))).toBe(code)
  })

  test('Read of a public key and of ~/.ssh/config is untouched', async ($, on) => {
    const w = world(on)
    const pub = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakePublicKeyMaterial0123456789abcdefgh app@mac\n'
    w.core = e => readRecord(String(e.file_path), pub) as never
    expect(contentOf(await $.tool.call({ tool: 'Read', file_path: `${HOME}/.ssh/id_ed25519.pub` }))).toBe(pub)
    const cfg = 'Host stand\n  HostName 203.0.113.7\n  User root\n  IdentityFile ~/.ssh/id_ed25519\n'
    w.core = e => readRecord(String(e.file_path), cfg) as never
    expect(contentOf(await $.tool.call({ tool: 'Read', file_path: `${HOME}/.ssh/config` }))).toBe(cfg)
  })

  test('commands the old hook denied now run: eval, source, docker inspect, printenv | cut', async ($, on) => {
    const w = world(on)
    for (const command of ['eval "$CMD"', 'set -a; . ./.env; set +a; node app.js', 'docker inspect app --format "{{.State.Status}}"', 'printenv | cut -d= -f1', 'cat .env.example', 'stat -f %z .env']) {
      const r = await bash($, w, 'ok\n', command)
      expect({ command, deny: r.deny }).toEqual({ command, deny: undefined })
    }
    expect(w.ran.length).toBe(6)
  })
})

describe('placeholders are never written back', () => {
  /** A placeholder exactly as the model sees it: produced by the mod from a .env read. */
  const produced = async ($: Engine, w: World) => firstMark(stdoutOf(await bash($, w, ENV_FILE)))

  test('a produced placeholder is denied in Write, Edit, MultiEdit, NotebookEdit and Bash before the tool runs', async ($, on) => {
    const w = world(on)
    const mark = await produced($, w)
    expect(mark).toMatch(/^‹secret:[A-Z_]+#[0-9a-f]{4}›$/)
    w.ran = []
    const calls = [
      { tool: 'Write', file_path: `${PROJ}/.env`, content: `DB_PASSWORD=${mark}\n` },
      { tool: 'Edit', file_path: `${PROJ}/.env`, old_string: 'PORT=3000', new_string: `X=${mark}` },
      { tool: 'MultiEdit', file_path: `${PROJ}/a.ts`, edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: mark }] },
      { tool: 'NotebookEdit', notebook_path: `${PROJ}/n.ipynb`, new_source: `key = "${mark}"` },
      { tool: 'Bash', command: `psql "postgres://u:${mark}@db/x"` },
    ]
    for (const c of calls) {
      const r = await $.tool.call(c as never)
      expect({ tool: c.tool, denied: typeof r.deny === 'string' }).toEqual({ tool: c.tool, denied: true })
      expect(JSON.stringify(r)).toContain('placeholder')
    }
    expect(w.ran).toEqual([])
  })

  test('the deny says how to use the value instead', async ($, on) => {
    const w = world(on)
    const mark = await produced($, w)
    const r = await $.tool.call({ tool: 'Bash', command: `curl -H "Authorization: Bearer ${mark}" x` })
    expect(JSON.stringify(r)).toContain('DATABASE_URL')
  })

  test('a write without a placeholder runs', async ($, on) => {
    const w = world(on)
    w.core = () => ({ result: { type: 'create', filePath: `${PROJ}/a.ts`, content: 'x', structuredPatch: [] } }) as never
    const r = await $.tool.call({ tool: 'Write', file_path: `${PROJ}/a.ts`, content: 'const password = process.env.DB_PASSWORD\n' })
    expect(r.deny).toBeUndefined()
    expect(w.ran).toEqual(['Write'])
  })

  test('review F5: the bare ‹secret:NAME› form is text: editing tests and docs, commit messages and grep run', async ($, on) => {
    const w = world(on)
    const bare = '‹secret:' + 'DB_PASSWORD›'
    w.core = () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never
    const calls = [
      { tool: 'Edit', file_path: `${PROJ}/tests/redact.test.ts`, old_string: 'x', new_string: `expect(out).toContain('DB_PASSWORD=${bare}')` },
      { tool: 'Write', file_path: `${PROJ}/README.md`, content: `Values come back as ${bare}; the name stays.\n` },
      { tool: 'Bash', command: `git commit -m "docs: show ${bare} in the README"` },
      { tool: 'Bash', command: "grep -rn '‹secret:' logs/" },
      { tool: 'Bash', command: `printf '%s' '${bare.slice(0, -1)}#nonce›'` },
    ]
    for (const c of calls) expect({ tool: c.tool, deny: (await $.tool.call(c as never)).deny }).toEqual({ tool: c.tool, deny: undefined })
    expect(w.ran.length).toBe(calls.length)
  })

  test('review F5: every placeholder of a session carries the same nonce', async ($, on) => {
    const w = world(on)
    const a = stdoutOf(await bash($, w, ENV_FILE))
    const b = stdoutOf(await bash($, w, `${FAKE.zshKey}\n`, 'echo $GEMINI_API_KEY'))
    const nonces = new Set([...`${a}${b}`.matchAll(/‹secret:[^›#\s]+#([0-9a-f]{4})›/g)].map(m => m[1]))
    expect(nonces.size).toBe(1)
  })

  test('review F6: a produced placeholder is denied in any tool input but the read-only and agent-messaging ones', async ($, on) => {
    const w = world(on)
    const mark = await produced($, w)
    w.ran = []
    const sinks = [
      { tool: 'mcp__claude_ai_Notion__notion-update-page', tool_use_id: 't1', data: { content: `pw: ${mark}` } },
      { tool: 'mcp__claude_ai_Gmail__send_message', tool_use_id: 't2', body: `the password is ${mark}` },
      { tool: 'mcp__claude_ai_Atlassian_Rovo__updateConfluencePage', tool_use_id: 't3', body: { nested: [{ text: mark }] } },
      { tool: 'Monitor', tool_use_id: 't4', command: `tail -f log | grep ${mark}` },
      { tool: 'mcp__computer-use__type', tool_use_id: 't5', text: mark },
      { tool: 'mcp__claude-in-chrome__form_input', tool_use_id: 't6', ref: 'x', value: mark },
      { tool: 'mcp__claude-in-chrome__javascript_tool', tool_use_id: 't7', text: `fill("${mark}")` },
    ]
    for (const c of sinks) expect({ tool: c.tool, denied: typeof (await $.tool.call(c as never)).deny === 'string' }).toEqual({ tool: c.tool, denied: true })
    expect(w.ran).toEqual([])
    w.core = () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }) as never
    const readers = [
      { tool: 'Grep', tool_use_id: 'r1', pattern: mark, path: PROJ },
      { tool: 'Glob', tool_use_id: 'r2', pattern: `**/${mark}` },
      { tool: 'Read', tool_use_id: 'r3', file_path: `${PROJ}/${mark}` },
      { tool: 'SubagentHandback', tool_use_id: 'r4', message: `the line came back as DB_PASSWORD=${mark}` },
      { tool: 'SendMessage', tool_use_id: 'r5', to: 'lead', message: `saw ${mark}` },
    ]
    for (const c of readers) expect({ tool: c.tool, deny: (await $.tool.call(c as never)).deny }).toEqual({ tool: c.tool, deny: undefined })
    expect(w.ran.length).toBe(readers.length)
  })
})

describe('fail closed', () => {
  const FAULT = { env: { SECRETS_REDACT_FAULT_INJECT: '1' } }

  test('Bash: when redaction throws, the output is hidden behind the error name', async ($, on) => {
    const w = world(on, FAULT)
    const r = await bash($, w, ENV_FILE)
    expect(JSON.stringify(r)).not.toContain(FAKE.dbPassword)
    expect(stdoutOf(r)).toContain('output hidden: secrets-redact failed (Error)')
    expect(w.ran).toEqual(['Bash'])
  })

  test('Read: when redaction throws, the file content is hidden', async ($, on) => {
    const w = world(on, FAULT)
    w.core = e => readRecord(String(e.file_path), ENV_FILE) as never
    const r = await $.tool.call({ tool: 'Read', file_path: `${PROJ}/.env` })
    expect(JSON.stringify(r)).not.toContain(FAKE.dbPassword)
    expect(contentOf(r)).toContain('output hidden: secrets-redact failed')
  })

  test('any other tool: when redaction throws, the call answers with the notice alone', async ($, on) => {
    const w = world(on, FAULT)
    w.core = () => ({ result: { content: [{ type: 'text', text: FAKE.ghToken }] } }) as never
    const r = await $.tool.call({ tool: 'mcp__github__get_me', tool_use_id: 'toolu_f1' } as never)
    expect(JSON.stringify(r)).not.toContain(FAKE.ghToken)
    expect(JSON.stringify(r)).toContain('output hidden: secrets-redact failed')
  })

  test('session.append: when redaction throws, the row text is hidden', async ($, on) => {
    const w = world(on, FAULT)
    await append($, {
      message: { type: 'attachment', name: 'hook_additional_context', role: 'user', isMeta: true, content: [{ type: 'text', text: `ctx ${FAKE.dbPassword}` }] },
      door: 'hook-context',
      origin: { kind: 'tool', tool: 'unknown' },
      uuid: 'row-f1',
    })
    expect(JSON.stringify(w.rows)).not.toContain(FAKE.dbPassword)
    expect(JSON.stringify(w.rows)).toContain('output hidden: secrets-redact failed')
  })
})

describe('session.append backstop', () => {
  const row = (door: string, text: string, extra: Record<string, unknown> = {}) => ({
    message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text }], ...extra },
    door,
    origin: { kind: 'tool', tool: 'unknown' },
    uuid: `row-${door}-${text.length}`,
  })

  test('an injected row (hook context, delivery, note) is hidden', async ($, on) => {
    const w = world(on)
    for (const door of ['hook-context', 'delivery', 'note', 'attachment', 'command']) {
      await append($, row(door, `here: DB_PASSWORD=${FAKE.dbPassword}`))
    }
    expect(w.rows.length).toBe(5)
    expect(JSON.stringify(w.rows)).not.toContain(FAKE.dbPassword)
  })

  test('what the owner typed (composer, Remote Control, the SDK host) and the model\'s response are left alone', async ($, on) => {
    const w = world(on)
    for (const kind of ['composer', 'bridge', 'sdk']) await append($, { ...row('prompt', `${kind} use ${FAKE.dbPassword}`), origin: { kind } })
    await append($, { message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text: `ok ${FAKE.dbPassword}` }] }, door: 'response', origin: { kind: 'model', model: 'm' }, uuid: 'row-r' })
    for (const kind of ['composer', 'bridge', 'sdk']) expect(JSON.stringify(w.rows)).toContain(`${kind} use ${FAKE.dbPassword}`)
    expect(JSON.stringify(w.rows)).toContain(`ok ${FAKE.dbPassword}`)
  })

  test('review F1: a prompt row the owner did not type (Monitor event, stalled shell output, peer, channel, schedule) is redacted', async ($, on) => {
    const w = world(on)
    const origins = [
      { kind: 'task-notification' }, { kind: 'scheduled-trigger' }, { kind: 'peer' }, { kind: 'peer-send-message' },
      { kind: 'projects-relay' }, { kind: 'coordinator' }, { kind: 'observer' }, { kind: 'unclassified' },
      { kind: 'channel', server: 'telegram' }, { kind: 'plugin', name: 'x' }, { kind: 'auto-continuation' }, { kind: 'slack-ping' },
    ]
    for (const origin of origins) {
      await append($, { ...row('prompt', `<event>Last output: DB_PASSWORD=${FAKE.dbPassword} ${FAKE.zshKey}</event>`), origin, uuid: `row-${origin.kind}` })
    }
    expect(w.rows.length).toBe(origins.length)
    expect(JSON.stringify(w.rows)).not.toContain(FAKE.dbPassword)
    expect(JSON.stringify(w.rows)).not.toContain(FAKE.zshKey)
  })

  test('review F1 (live): a Monitor event or task notification submitted as a prompt is redacted before it is queued; the owner\'s prompt is not', async ($, on) => {
    const w = world(on)
    await $.prompt.submit({ text: `<event>DB_PASSWORD=${FAKE.dbPassword}</event>`, origin: { kind: 'task-notification' }, wait: false, context: [`ctx ${FAKE.zshKey}`] } as never)
    expect(JSON.stringify(w.submitted[0])).not.toContain(FAKE.dbPassword)
    expect(JSON.stringify(w.submitted[0])).not.toContain(FAKE.zshKey)
    expect(norm(w.submitted[0]!.text)).toContain('DB_PASSWORD=‹secret:DB_PASSWORD›')
    await $.prompt.submit({ text: `use ${FAKE.dbPassword}`, origin: { kind: 'composer' }, wait: false } as never)
    expect(w.submitted[1]!.text).toBe(`use ${FAKE.dbPassword}`)
  })

  test('review F1: session.receive redacts a delivery before it is queued; the owner\'s Remote Control message is left alone', async ($, on) => {
    const w = world(on)
    const r = await $.session.receive({ origin: { kind: 'task-notification' }, text: `<event>env: GEMINI_API_KEY=${FAKE.zshKey}</event>` })
    expect(w.received[0]).not.toContain(FAKE.zshKey)
    expect(norm(w.received[0])).toContain('GEMINI_API_KEY=‹secret:GEMINI_API_KEY›')
    expect(String((r as { text?: string }).text)).not.toContain(FAKE.zshKey)
    await $.session.receive({ origin: { kind: 'peer', plugin: undefined }, text: `peer saw ${FAKE.dbPassword}` })
    expect(w.received[1]).not.toContain(FAKE.dbPassword)
    await $.session.receive({ origin: { kind: 'bridge' }, text: `use ${FAKE.dbPassword}` })
    expect(w.received[2]).toBe(`use ${FAKE.dbPassword}`)
  })

  test('a tool_result row tool.call did not handle is hidden; one it handled is not walked twice', async ($, on) => {
    const w = world(on)
    // handled: the Bash call ran through tool.call under this id
    w.core = () => ({ result: { stdout: 'clean', stderr: '', interrupted: false } }) as never
    await $.tool.call({ tool: 'Bash', command: 'true', tool_use_id: 'toolu_done' } as never)
    const tr = (id: string, content: string) => ({
      message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
      door: 'tool-result',
      origin: { kind: 'tool', tool: 'Bash' },
      uuid: `row-${id}`,
    })
    await append($, tr('toolu_other', `DB_PASSWORD=${FAKE.dbPassword}`))
    expect(JSON.stringify(w.rows[0])).not.toContain(FAKE.dbPassword)
    expect(JSON.stringify(w.rows[0])).toContain('toolu_other')
    // The handled id's row is relayed without a second walk (its record was
    // redacted before core mapped it), once: the id is consumed, so a later row
    // under it is walked again.
    await append($, tr('toolu_done', `marker ${FAKE.dbPassword}`))
    await append($, tr('toolu_done', `marker ${FAKE.dbPassword}`))
    expect(JSON.stringify(w.rows[1])).toContain(FAKE.dbPassword)
    expect(JSON.stringify(w.rows[2])).not.toContain(FAKE.dbPassword)
  })
})

describe('review 2026-10-04: sources, encodings, failure modes, speed', () => {
  const F3 = {
    LOWER_PASSWORD: 'qwertyuiopas',
    NUM_PASSWORD: '8473629105',
    SHORT_PASSWORD: 'Ab3#xy7',
    SPACE_PASSWORD: 'correct horse battery staple',
    DOT_PASSWORD: 'my.secret.pass',
    ADMIN_PASSWORD: 'add-my-fake-key-2024',
  }

  test('review F3: a secret-named value of any shape is known: lowercase, digits, short, spaced, dotted, placeholder-looking', async ($, on) => {
    const w = world(on)
    const extra = Object.entries(F3).map(([k, v]) => `${k}="${v}"`).join('\n')
    w.files.set(`${PROJ}/.env`, { text: `${ENV_FILE}${extra}\nPG_PASSWORD=postgres\nTODO_TOKEN=changeme\n`, mtimeMs: T0 })
    for (const [k, v] of Object.entries(F3)) {
      expect({ k, out: norm(stdoutOf(await bash($, w, `${v}\n`, `echo $${k}`))) }).toEqual({ k, out: `‹secret:${k}›\n` })
    }
    // a common default or a placeholder word is not a value worth hiding everywhere
    expect(stdoutOf(await bash($, w, 'postgres changeme\n', 'echo'))).toBe('postgres changeme\n')
  })

  test('review F3: session.start warns on the status line when no extraFiles are configured', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJ, surface: null, isInteractive: false })
    expect(w.status.some(t => typeof t === 'string' && t.includes('extraFiles'))).toBe(true)
  })

  test('review F3: and says nothing when extraFiles are set and present', { options: { extraFiles: [ACCESS] } }, async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJ, surface: null, isInteractive: false })
    expect(w.status.filter(t => typeof t === 'string')).toEqual([])
  })

  test('review F4: encoded forms of a known value are hidden (JSON escapes, entities, URL-encoding, base64url, short base64, wrapped base64)', async ($, on) => {
    const w = world(on)
    const v = {
      quote: 'Ab"c\\d-Fake-99',
      slash: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYzz12',
      amp: 'Ab&cd<12-Fake-34',
      cyr: 'парольFake12',
      eight: 'Zq9-xK2p',
      url: 'Ab c/d?e=f&g-Fake-56',
    }
    const env = [
      `QUOTE_PASSWORD='${v.quote}'`, `SLASH_TOKEN=${v.slash}`, `AMP_PASSWORD="${v.amp}"`, `CYR_PASSWORD=${v.cyr}`,
      `EIGHT_PASSWORD=${v.eight}`, `URL_TOKEN="${v.url}"`, 'NODE_ENV=production', 'LOG_LEVEL=debug',
    ].join('\n')
    w.files.set(`${PROJ}/.env`, { text: `${ENV_FILE}${env}\n`, mtimeMs: T0 })
    const b64 = (x: string) => btoa(unescape(encodeURIComponent(x)))
    const cases: [string, string, string][] = [
      ['container Env JSON with a quote and a backslash', JSON.stringify({ Env: [`POSTGRES_PASSWORD=${v.quote}`] }), 'Fake-99'],
      ['PHP json_encode escaping /', `{"aws":"${v.slash.replace(/\//g, '\\/')}"}`, v.slash.slice(0, 13)],
      ['XML-escaped inside an <event>', `<event>${v.amp.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</event>`, '-Fake-34'],
      ['JSON ensure_ascii', JSON.stringify({ v: v.cyr }).replace(/[\u0400-\u04ff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')), 'Fake12'],
      ['URL-encoded in a query string', `GET /cb?state=${encodeURIComponent(v.url)}&x=1`, encodeURIComponent(v.url).slice(0, 12)],
      ['base64url', `token=${b64(`x:${v.slash}`).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`, b64(`x:${v.slash}`).replace(/\+/g, '-').replace(/\//g, '_').slice(4, 30)],
      ['an 8-char value inside a base64 blob', b64(`prefix junk ${v.eight} suffix`), b64(`prefix junk ${v.eight} suffix`)],
    ]
    for (const [name, text, leak] of cases) {
      const out = stdoutOf(await bash($, w, text, 'x'))
      expect({ name, leaked: out.includes(leak), marked: out.includes('‹secret:') }).toEqual({ name, leaked: false, marked: true })
    }
    // GNU base64 wraps at 76: a short .env takes 2-3 lines, under the 4-line block rule
    const dotenv = `NODE_ENV=development\nPORT=3000\nDB_PASSWORD=${FAKE.dbPassword}\nLOG_LEVEL=debug\n`
    const wrapped = (b64(dotenv).match(/.{1,76}/g) ?? []).join('\n') + '\n'
    const out = stdoutOf(await bash($, w, wrapped, 'base64 -w76 .env'))
    let decoded = ''
    try { decoded = atob(out.replace(/\n/g, '')) } catch { decoded = '' }
    expect(decoded.includes(FAKE.dbPassword)).toBe(false)
    expect(out).toContain('‹secret:')
  })

  test('review F2 (live PHP case): a token a rule found is hidden where it appears bare, in the same output and in later ones', async ($, on) => {
    const w = world(on)
    const tok = 'Lrn3dT0kenValue9xQ2mZ7pK4wR8sV1yB6'
    const first = stdoutOf(await bash($, w, `'token' => '${tok}',\n// $this->make_request_mono('${tok}', 'personal/client-info');\n`, 'cat a.php'))
    expect(first).not.toContain(tok)
    expect(first).toContain('make_request_mono(')
    expect(stdoutOf(await bash($, w, `call('${tok}')\n`, 'grep -n make_request b.php'))).not.toContain(tok)
    // a short password found by a rule is hidden across its own output only; a word is never spread
    const own = stdoutOf(await bash($, w, "password = 'hunter22x'\nretry with hunter22x\n", 'cat c.ini'))
    expect(own).not.toContain('hunter22x')
    expect(stdoutOf(await bash($, w, 'hunter22x\n', 'echo'))).toBe('hunter22x\n')
  })

  test('review F7: until the first good index build the output is hidden; it shows once a build succeeds', async ($, on) => {
    const w = world(on)
    w.procOk = false
    const r1 = await bash($, w, ENV_FILE)
    expect(stdoutOf(r1)).toContain('output hidden: secrets-redact failed')
    expect(JSON.stringify(r1)).not.toContain(FAKE.dbPassword)
    w.procOk = true
    // a failed build is retried at the sweep's pace, not on every call
    await w.clock.advance(2_500)
    const r2 = norm(stdoutOf(await bash($, w, ENV_FILE)))
    expect(r2).toContain('DB_PASSWORD=‹secret:DB_PASSWORD›')
  })

  test('review F7: a source that failed to read is read again, not remembered as empty', async ($, on) => {
    const w = world(on)
    w.readFails.set(`${PROJ}/.env`, 1)
    await bash($, w, 'warm')
    await w.clock.advance(2_500)
    expect(norm(stdoutOf(await bash($, w, `${FAKE.dbPassword}\n`, 'echo $DB_PASSWORD')))).toBe('‹secret:DB_PASSWORD›\n')
  })

  test('review F7: a result nested deeper than 40 levels is still redacted', async ($, on) => {
    const w = world(on)
    let deep: unknown = { text: `token=${FAKE.ghToken}` }
    for (let i = 0; i < 60; i++) deep = { level: i, child: deep }
    w.core = () => ({ result: { content: [{ type: 'text', text: 'top' }], deep } }) as never
    const r = await $.tool.call({ tool: 'mcp__x__deep', tool_use_id: 'toolu_deep' } as never)
    expect(JSON.stringify(r)).not.toContain(FAKE.ghToken)
  })

  test('review F7: a .env below the git root (api/.env) is a source', async ($, on) => {
    const w = world(on)
    w.dirs.add(`${PROJ}/api`)
    w.dirs.add(`${PROJ}/api/config`)
    w.files.set(`${PROJ}/api/config/.env.local`, { text: 'API_SERVICE_TOKEN=Nest3d-Api-Secret-41\n', mtimeMs: T0 })
    expect(norm(stdoutOf(await bash($, w, 'Nest3d-Api-Secret-41\n', 'echo')))).toBe('‹secret:API_SERVICE_TOKEN›\n')
  })

  test('review F8: adversarial 100k-character inputs are linear (each well under a second)', { timeoutMs: 60_000 }, async () => {
    const words = ['react', 'dom', 'server', 'browser', 'production', 'min', 'js', 'chunk', 'vendor', 'lodash', 'es']
    let slug = ''
    for (let i = 0; slug.length < 120_000; i++) slug += words[i % words.length] + (i % 7 === 6 ? '.' : '-')
    const inputs: [string, string][] = [
      ["'-a' x50k then ' ='", 'x' + '-a'.repeat(50_000) + ' =1'],
      ['120 KB hyphen/dot identifiers then " ="', slug + ' =1'],
      ["'mysql ' x20k then -p", 'mysql '.repeat(20_000) + '-p'],
      ["'sshpass ' x20k then -p", 'sshpass '.repeat(20_000) + '-p'],
      ["'<a ' x33k (XML)", '<a '.repeat(33_000) + '</a>'],
      ['quotes and names', '"a'.repeat(50_000) + '=1"'],
      ["'a:' x50k", 'a:'.repeat(50_000) + '=1'],
      ["'x=' x50k", 'x='.repeat(50_000)],
      ['define( x20k', "define('A',".repeat(10_000)],
      ['20k hits of NAME=value (output assembly)', 'DB_PASSWORD=Fk3-x-PASS-1\n'.repeat(5_000)],
      ['grep prefixes x5k', './a/b.env:12:X=1\n'.repeat(6_000)],
      ['base64 lines', ('QUJDRGVmZ2gxMjM0NTY3OA'.repeat(4).slice(0, 76) + '\n').repeat(1_300)],
      ["'://' x30k", 'a://b:'.repeat(20_000)],
    ]
    for (const [name, text] of inputs) {
      const t0 = performance.now()
      redactText(text, EMPTY_INDEX)
      const ms = performance.now() - t0
      expect({ name, slow: ms > 1_000 }).toEqual({ name, slow: false })
    }
  })

  test('redaction is idempotent: a second pass over redacted text changes nothing', { timeoutMs: 20_000 }, async () => {
    for (const c of LEAKS) {
      const once = redactText(c.text, EMPTY_INDEX)
      expect({ case: c.name, stable: redactText(once, EMPTY_INDEX) === once }).toEqual({ case: c.name, stable: true })
    }
  })
})

// Round 2 of the review, 2026-10-04.
describe('review round 2', () => {
  test('B1: every placeholder the mod writes is one the deny reads back, a name with spaces or the mark included', () => {
    for (const name of ['api key', 'DB Password', 'auth token', 'Доступы сервер', 'a\tb\nc', 'x›y', '', ' ', 'k'.repeat(300)]) {
      expect({ name, read: hasPlaceholder(placeholder(name)) }).toEqual({ name, read: true })
    }
  })

  test('B1: a placeholder written into a config with a spaced key is denied in a Write', async ($, on) => {
    const w = world(on)
    const out = stdoutOf(await bash($, w, `{"api key": "${FAKE.jsonApiKey}"}`, 'cat cfg.json'))
    expect(out).not.toContain(FAKE.jsonApiKey)
    const r = await $.tool.call({ tool: 'Write', file_path: `${PROJ}/cfg.json`, content: out } as never)
    expect(String((r as { deny?: string }).deny ?? '')).toContain('placeholder')
    expect(w.ran).not.toContain('Write')
  })

  test('N6: a short known value is hidden as a word, not inside another word or a path', () => {
    const idx = buildIndex([{ name: 'SMTP_PASS', value: 'mailer' }, { name: 'DB_PASSWORD', value: 'shopco' }])
    const out = norm(redactText('import nodemailer; ls shopco-legacy/x; pass=mailer; db shopco', idx))
    expect(out).toBe('import nodemailer; ls ‹secret:DB_PASSWORD›-legacy/x; pass=‹secret:SMTP_PASS›; db ‹secret:DB_PASSWORD›')
  })

  test('N6: values a rule found are reused in the same text as whole words, every one of them (not only the first)', () => {
    const out = norm(redactText('password=Qmailer01\nsecret=hunter22\nimport nodeQmailer01x; xhunter22y\nagain hunter22 and Qmailer01', EMPTY_INDEX))
    expect(out).toContain('import nodeQmailer01x; xhunter22y')
    expect(out).not.toMatch(/(?<![A-Za-z0-9])(hunter22|Qmailer01)(?![A-Za-z0-9])/)
  })

  test('N1: a credential file re-rendered as an attachment is hidden whole; a summary that names one is not', async ($, on) => {
    const w = world(on)
    const hist = `${HOME}/.zsh_history`
    await append($, {
      message: { type: 'attachment', name: 'edited_text_file', role: 'user', isMeta: true, content: [{ type: 'text', text: `Note: ${hist} was modified\n: 1696:0;mysql -uroot -pHunter2xyz db` }] },
      door: 'attachment', origin: { kind: 'engine' }, uuid: 'row-hist',
    })
    await append($, {
      message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text: `Summary: read ${hist} earlier; plan continues` }] },
      door: 'compaction', origin: { kind: 'engine' }, uuid: 'row-sum',
    })
    expect(JSON.stringify(w.rows[0])).not.toContain('Hunter2xyz')
    expect(JSON.stringify(w.rows[0])).toContain('credential file')
    expect(JSON.stringify(w.rows[1])).toContain('plan continues')
  })

  test('heartbeat: the session start and every prompt after a /clear leave the file the guard script checks', async ($, on) => {
    const w = world(on)
    await $.session.start({ cwd: PROJ, surface: 'terminal', isInteractive: true } as never)
    expect(w.files.has(`${HOME}/.claude/state/secrets-redact/alive/sess-1`)).toBe(true)
    w.sessionId = 'sess-2'
    await $.prompt.submit({ text: 'hi', origin: { kind: 'composer' }, wait: false } as never)
    expect(w.files.has(`${HOME}/.claude/state/secrets-redact/alive/sess-2`)).toBe(true)
  })
})

// A grep -n over a JSON log (stop-point's writes.log) was hidden from its 5th colon to the end of the line as a
// .pgpass password, and that tail was then learned and hidden in later outputs too.
describe('a line rule hides one field, never ordinary output', () => {
  const LOG = 'writes.log:3:{"agent":"probe:k7Qx2","input_tokens":1840,"output_tokens":412,"cost_usd":0.0213}'
  const STAMPED = '2026-10-04T18:48:12Z {"agent":"probe:k7Qx2","output_tokens":412,"ms":5120}'
  const TAIL = 'k7Qx2","input_tokens":1840,"output_tokens":412,"cost_usd":0.0213}'

  test('grep -n and timestamped lines of a JSON log come back as given', () => {
    for (const text of [LOG, STAMPED, `${LOG}\n${STAMPED}\n`, `${LOG.replace('writes.log:3:', '')}\n`]) {
      expect({ text, out: redactText(text, EMPTY_INDEX) }).toEqual({ text, out: text })
    }
  })

  test('through Bash: the JSON tail is neither hidden nor learned for later outputs', async ($, on) => {
    const w = world(on)
    expect(stdoutOf(await bash($, w, `${LOG}\n${STAMPED}\n`, 'grep -n probe writes.log'))).toBe(`${LOG}\n${STAMPED}\n`)
    expect(stdoutOf(await bash($, w, `${TAIL}\n`, 'tail -1 writes.log'))).toBe(`${TAIL}\n`)
  })

  test('grep -n hits with five colon fields stay: a line number is not a Postgres port, a sentence is not a field', () => {
    for (const text of [
      'src/db.ts:12:host:localhost:5432',
      'docker-compose.yml:7:image:node:20-alpine',
      'notes.md:3:todo:ask:Denis-about-it',
      'app.log:812:ERROR:pool:timeout-after-5000ms',
      '12:34:56:note:retry-in-30s',
    ]) {
      expect({ text, out: redactText(text, EMPTY_INDEX) }).toEqual({ text, out: text })
    }
  })

  test('a secret-named key whose unquoted value runs into a JSON tail hides the value, not the tail', () => {
    const out = norm(redactText('  password: Qz8rT4vW2xy","user":"acme","retries":3\n', EMPTY_INDEX))
    expect(out).toBe('  password: ‹secret:password›","user":"acme","retries":3\n')
  })

  test('a long pgpass password with any names is hidden and learned for later outputs', async ($, on) => {
    const w = world(on)
    const pw = 'Fk9pgpassLongValue42'
    const out = stdoutOf(await bash($, w, `localhost:543:книги:app%ro#1:${pw}\n`, 'cat ~/.pgpass'))
    expect(out).not.toContain(pw)
    expect(stdoutOf(await bash($, w, `${pw}\n`, 'echo'))).not.toContain(pw)
  })

  test('a secret-named value holding quotes, colons and commas is hidden whole and learned', async ($, on) => {
    const w = world(on)
    for (const [text, pw] of [
      [`DB_PASSWORD='Xy7":9abcQ4mZ8pLw'\n`, 'Xy7":9abcQ4mZ8pLw'],
      [`password: p0','Wq8zR2kT5vNx\n`, "p0','Wq8zR2kT5vNx"],
      [`"api_token": "Rt5\\":7,\\"zQ9mK2pL8"\n`, 'Rt5\\":7,\\"zQ9mK2pL8'],
    ] as const) {
      const out = stdoutOf(await bash($, w, text, 'cat cfg'))
      expect({ text, out: out.includes(pw) }).toEqual({ text, out: false })
      expect({ pw, later: stdoutOf(await bash($, w, `${pw}\n`, 'echo')).includes(pw) }).toEqual({ pw, later: false })
    }
  })

  test('a JSON fragment is never a value known everywhere; a random token still is', () => {
    expect(isKnownCandidate('k7Qx2","input_tokens":1840,"output_tokens":412,"cost_usd":0.0213}', false)).toBe(false)
    expect(isKnownCandidate('Qz8rT4vW2xy9","user":"acme"', true)).toBe(false)
    expect(isKnownCandidate('Xy7":9abcQ4mZ8pLw', false)).toBe(true)
    expect(isKnownCandidate("p0','Wq8zR2kT5vNx", false)).toBe(true)
    expect(isKnownCandidate('Lrn3dT0kenValue9xQ2mZ7pK4wR8sV1yB6', false)).toBe(true)
    expect(isKnownCandidate(FAKE.pgpassPw, true)).toBe(true)
  })

  test('a real .pgpass line still hides exactly its password, and only it', () => {
    const pw = FAKE.pgpassPw
    const mark = '‹secret:pgpass-password›'
    const cases: [line: string, hidden: string][] = [
      [`localhost:5432:acme:acme:${pw}`, `localhost:5432:acme:acme:${mark}`],
      [`*:*:*:postgres:${pw}`, `*:*:*:postgres:${mark}`],
      [`db.example.com:6432:shop_db:app.user@srv:${pw}\r`, `db.example.com:6432:shop_db:app.user@srv:${mark}\r`],
      [`/var/run/postgresql:5432:acme:acme:${pw}`, `/var/run/postgresql:5432:acme:acme:${mark}`],
      [`\\:\\:1:5432:acme:acme:${pw}  `, `\\:\\:1:5432:acme:acme:${mark}  `],
      // grep -n over the file itself
      [`/home/fake/.pgpass:1:localhost:5432:acme:acme:${pw}`, `/home/fake/.pgpass:1:localhost:5432:acme:acme:${mark}`],
      // an escaped colon belongs to the password; libpq ends it at the first unescaped one
      [`localhost:5432:acme:acme:ab\\:${pw}`, `localhost:5432:acme:acme:${mark}`],
      [`localhost:5432:acme:acme:${pw}:old-field`, `localhost:5432:acme:acme:${mark}:old-field`],
      // libpq takes any name and port: Cyrillic, punctuation, a low port, a leading zero, grep -n of one file
      [`localhost:5432:книги:менеджер:${pw}`, `localhost:5432:книги:менеджер:${mark}`],
      [`db.local:5432:shop:app%ro#1!=~:${pw}`, `db.local:5432:shop:app%ro#1!=~:${mark}`],
      [`localhost:543:acme:acme:${pw}`, `localhost:543:acme:acme:${mark}`],
      [`localhost:05432:acme:acme:${pw}`, `localhost:05432:acme:acme:${mark}`],
      [`1:localhost:5432:acme:acme:${pw}`, `1:localhost:5432:acme:acme:${mark}`],
    ]
    for (const [line, hidden] of cases) {
      const out = redactText(`${line}\nnext line stays\n`, EMPTY_INDEX)
      expect({ line, out: norm(out) }).toEqual({ line, out: `${hidden}\nnext line stays\n` })
    }
  })
})
