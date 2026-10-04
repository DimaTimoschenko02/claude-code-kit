// secrets-redact: never blocks a read; hides secret VALUES in everything the
// model reads. Names, listings and structure stay visible, commands run, and a
// variable is used by substitution (psql "$DATABASE_URL") without its value
// ever reaching the model.
//
// tool.call (every tool, subagents included) is the primary path: the result is
// rewritten before core maps it for the model and records it, so the transcript
// stores the redacted record too. session.receive rewrites a delivery before it
// is queued; session.append is the backstop for every other row the model reads,
// prompts included unless the owner typed them. All of them fail closed: until
// the first good index build, and whenever redaction throws, the text is hidden.

import type { Hook, Register, ToolCallResult } from 'claude-code'
import {
  PLACEHOLDER_DENY,
  buildIndex,
  credentialFileKind,
  credentialNotice,
  credentialPathIn,
  EMPTY_INDEX,
  inputHasPlaceholder,
  isKnownCandidate,
  isSecretName,
  nonceFor,
  parseDotenv,
  parseEnvDump,
  parseMarkdownSecrets,
  parseMcpJson,
  parseSettingsEnv,
  parseShellRc,
  redactDeep,
  redactText,
  secretsFromPairs,
  setNonce,
  signatureOf,
  type Index,
  type Secret,
} from './redact.ts'

type Engine = Parameters<Hook<'tool.call'>>[0]
type Kind = 'dotenv' | 'shell' | 'mcp' | 'settings' | 'markdown'
type Spec = { readonly path: string; readonly kind: Kind }
type Cached = { readonly mtime: number; readonly size: number; readonly secrets: readonly Secret[] }
type DirScan = { readonly mtime: number; readonly specs: readonly Spec[]; readonly children: readonly string[] }
type Walk = { readonly at: number; readonly dirs: readonly string[] }

/** How often a tool call may trigger the stat sweep that notices edited source files. */
const CHECK_MS = 2000
/** How often the tree below a base directory is walked again for new `.env*` files. */
const WALK_MS = 60_000
const WALK_MAX_DEPTH = 6
const WALK_MAX_DIRS = 1000
const SKIP_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'coverage', 'tmp', 'var', 'logs', '__pycache__', 'bower_components'])
const TEMPLATE = /\.(example|sample|template|dist|tpl)$|\.(example|sample|template)\./
/** Values found by a rule and learned for later outputs: at most this many. */
const LEARN_MAX = 1000

/**
 * Tools whose input is read, not written anywhere a value would land: a
 * placeholder there is a search term or a quote (a subagent reporting what it
 * saw), so it is not denied. Every other tool, MCP writers included, is.
 */
const NO_SINK_TOOLS = new Set([
  'Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'ToolSearch', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode',
  'SubagentHandback', 'SendMessage', 'Agent', 'Task',
])

/** Who typed a prompt row: only these are the owner's own words, left as typed. */
const OWNER_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

class IndexNotReady extends Error {
  constructor() {
    super('secrets-redact has not built its index yet')
    this.name = 'IndexNotReady'
  }
}

// Module state: a hot reload starts it over, which is just a fresh load.
const state = {
  idx: EMPTY_INDEX as Index,
  sig: '',
  /** True once an index build succeeded: until then every output is hidden. */
  ready: false,
  fault: false,
  home: '',
  homeRead: false,
  /** The process env's secrets, read once per load; null until that read succeeds. */
  env: null as readonly Secret[] | null,
  /** The last build's sources, so a learned value can rebuild the index without a sweep. */
  sources: [] as readonly Secret[],
  learned: new Map<string, string>(),
  files: new Map<string, Cached>(),
  dirs: new Map<string, DirScan>(),
  walks: new Map<string, Walk>(),
  gitRoots: new Map<string, string | null>(),
  missingExtra: 0,
  lastCheck: 0,
  running: null as Promise<void> | null,
  /** tool_use_ids tool.call already redacted, so session.append skips their rows. */
  done: new Set<string>(),
  /** Session ids whose heartbeat file is written; the guard script denies every tool call of a session without one. */
  beaten: new Set<string>(),
  /** The status-line note last shown, so it is set again only when it changes. */
  shown: undefined as string | undefined,
  /** The last failed build's error name, shown while no index is ready. */
  lastError: '',
}

const unique = <T>(xs: readonly T[]): T[] => [...new Set(xs)]
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const join = (dir: string, name: string) => (dir.endsWith('/') ? dir + name : `${dir}/${name}`)

function specForPath(path: string): Spec {
  const base = basename(path)
  if (/\.md$/i.test(base)) return { path, kind: 'markdown' }
  if (/settings(\.local)?\.json$/.test(base)) return { path, kind: 'settings' }
  if (/\.json$/i.test(base)) return { path, kind: 'mcp' }
  if (/^\.(zshenv|zshrc|zprofile|bashrc|bash_profile|profile|envrc)$/.test(base)) return { path, kind: 'shell' }
  return { path, kind: 'dotenv' }
}

function homeSpecs(home: string): Spec[] {
  if (!home) return []
  return [
    ...['.zshenv', '.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.profile'].map(f => ({ path: join(home, f), kind: 'shell' as const })),
    { path: join(home, '.claude.json'), kind: 'mcp' },
    { path: join(home, '.claude/settings.json'), kind: 'settings' },
    { path: join(home, '.claude/settings.local.json'), kind: 'settings' },
  ]
}

function harvest(spec: Spec, text: string): Secret[] {
  switch (spec.kind) {
    case 'dotenv': return secretsFromPairs(parseDotenv(text))
    case 'shell': return secretsFromPairs(parseShellRc(text))
    case 'mcp': return secretsFromPairs(parseMcpJson(text))
    case 'settings': return secretsFromPairs(parseSettingsEnv(text))
    case 'markdown': return parseMarkdownSecrets(text, basename(spec.path))
  }
}

/** A source's secrets, re-read only when its mtime or size changed. A failed read is not cached: the next sweep reads again. */
async function loadSpec($: Engine, spec: Spec): Promise<readonly Secret[]> {
  const st = await $.fs.stat(spec.path).catch(() => null)
  if (!st || st.kind !== 'file' || st.size > 4_000_000) {
    state.files.delete(spec.path)
    return []
  }
  const cached = state.files.get(spec.path)
  if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached.secrets
  let text: string
  try {
    text = await $.fs.read(spec.path)
  } catch {
    state.files.delete(spec.path)
    return []
  }
  const secrets = harvest(spec, text)
  state.files.set(spec.path, { mtime: st.mtimeMs, size: st.size, secrets })
  return secrets
}

/** The dotenv-style files and child directories of one directory, re-listed only when the directory changed. */
async function scanDir($: Engine, dir: string): Promise<DirScan | null> {
  const st = await $.fs.stat(dir).catch(() => null)
  if (!st || st.kind !== 'dir') return null
  const prior = state.dirs.get(dir)
  if (prior && prior.mtime === st.mtimeMs) return prior
  const entries = await $.fs.list(dir).catch(() => [])
  const specs: Spec[] = [
    { path: join(dir, '.claude/settings.json'), kind: 'settings' },
    { path: join(dir, '.claude/settings.local.json'), kind: 'settings' },
  ]
  const children: string[] = []
  for (const en of entries) {
    if (en.kind === 'dir') {
      if (!en.isLink && !en.name.startsWith('.') && !SKIP_DIRS.has(en.name)) children.push(join(dir, en.name))
      continue
    }
    if ((en.name === '.env' || en.name.startsWith('.env.')) && !TEMPLATE.test(en.name)) specs.push({ path: join(dir, en.name), kind: 'dotenv' })
    else if (en.name === '.envrc') specs.push({ path: join(dir, en.name), kind: 'shell' })
    else if (en.name === '.mcp.json') specs.push({ path: join(dir, en.name), kind: 'mcp' })
  }
  const scan = { mtime: st.mtimeMs, specs, children }
  state.dirs.set(dir, scan)
  return scan
}

/**
 * The sources in and below `base`: breadth first, at most WALK_MAX_DEPTH deep
 * and WALK_MAX_DIRS directories, no symlinks, dot or build directories. The
 * whole tree is walked again every WALK_MS; in between only `base` itself is
 * re-listed (a new root .env shows at once) and the known files re-stat'ed.
 */
async function sourcesBelow($: Engine, base: string, now: number): Promise<Spec[]> {
  const prior = state.walks.get(base)
  if (prior && now - prior.at < WALK_MS) {
    const scans = await Promise.all(prior.dirs.map(d => (d === base ? scanDir($, d) : Promise.resolve(state.dirs.get(d) ?? null))))
    return scans.flatMap(s => (s ? [...s.specs] : []))
  }
  const dirs: string[] = []
  const specs: Spec[] = []
  let level = [base]
  for (let depth = 0; depth <= WALK_MAX_DEPTH && level.length > 0 && dirs.length < WALK_MAX_DIRS; depth++) {
    const room = WALK_MAX_DIRS - dirs.length
    const batch = level.slice(0, room)
    const scans = await Promise.all(batch.map(d => scanDir($, d)))
    const next: string[] = []
    batch.forEach((d, i) => {
      const s = scans[i]
      if (!s) return
      dirs.push(d)
      specs.push(...s.specs)
      next.push(...s.children)
    })
    level = next
  }
  state.walks.set(base, { at: now, dirs })
  return specs
}

/** The git work tree holding `dir`, found by looking for .git upwards; cached per directory. */
async function gitRoot($: Engine, dir: string): Promise<string | null> {
  const hit = state.gitRoots.get(dir)
  if (hit !== undefined) return hit
  const ups: string[] = []
  for (let d = dir; d.length > 1; d = d.slice(0, Math.max(1, d.lastIndexOf('/')))) ups.push(d)
  const has = await Promise.all(ups.map(d => $.fs.exists(join(d, '.git')).catch(() => false)))
  const root = ups.find((_, i) => has[i]) ?? null
  state.gitRoots.set(dir, root)
  return root
}

/** Secret-named variables of this process, which every Bash child inherits; once per load. Throws when env cannot be read. */
async function loadProcessEnv($: Engine): Promise<readonly Secret[]> {
  const run = await $.process.run(['/usr/bin/env', '-0'], { timeoutMs: 5000 })
  if (run.exitCode !== 0) throw new Error(`env -0 exited ${run.exitCode}`)
  return secretsFromPairs(parseEnvDump(run.stdout).filter(([name]) => isSecretName(name)))
}

/** HOME, the fault switch and the placeholder nonce: read once, before any deny check or redaction. */
async function ensureHome($: Engine): Promise<void> {
  if (state.homeRead) return
  const [home, fault] = await Promise.all([$.env.get('HOME'), $.env.get('SECRETS_REDACT_FAULT_INJECT')])
  state.home = home ?? ''
  state.fault = fault === '1'
  setNonce(nonceFor(`secrets-redact:${state.home}`))
  state.homeRead = true
}

const learnedSecrets = (): Secret[] => [...state.learned].map(([value, name]) => ({ name, value }))

function rebuild(sources: readonly Secret[]): void {
  state.sources = sources
  const all = [...sources, ...learnedSecrets()]
  const sig = signatureOf(all)
  if (sig !== state.sig) {
    state.idx = buildIndex(all)
    state.sig = sig
  }
}

async function refresh($: Engine, extraFiles: readonly string[], now: number): Promise<void> {
  await ensureHome($)
  if (state.env === null) state.env = await loadProcessEnv($)
  const [root, cwd] = await Promise.all([$.session.root(), $.session.cwd()])
  const bases = unique([root, cwd])
  const gits = await Promise.all(bases.map(b => gitRoot($, b)))
  const walkRoots = unique(bases.map((b, i) => gits[i] ?? b))
  const scans = await Promise.all(walkRoots.map(r => sourcesBelow($, r, now)))
  const byPath = new Map<string, Spec>()
  for (const s of [...homeSpecs(state.home), ...extraFiles.map(specForPath), ...scans.flat()]) byPath.set(s.path, s)
  const lists = await Promise.all([...byPath.values()].map(s => loadSpec($, s)))
  state.missingExtra = extraFiles.filter(f => !state.files.has(f)).length
  rebuild([...state.env, ...lists.flat()])
  state.ready = true
}

/**
 * Refreshes the known values at most every CHECK_MS once ready; until the first
 * good build every call tries again. A failed refresh after that keeps the last
 * index (shapes and key names still apply); before it, output stays hidden.
 */
async function ensureFresh($: Engine, extraFiles: readonly string[]): Promise<void> {
  if (state.running) return state.running
  const now = await $.clock.now()
  if (state.running) return state.running
  // a failing build is retried at the same pace as a sweep, not on every call
  if (now - state.lastCheck < CHECK_MS) return
  state.lastCheck = now
  state.running = refresh($, extraFiles, now)
    .catch((err: unknown) => {
      state.lastError = err instanceof Error ? err.name : 'error'
      try {
        $.ui.log(`secrets-redact: refresh failed (${err instanceof Error ? err.name : 'error'}); ${state.ready ? 'known values kept' : 'output stays hidden until a build succeeds'}`, { to: 'debug' })
      } catch {
        // the log is best effort
      }
    })
    .finally(() => {
      state.running = null
    })
  return state.running
}

async function ready($: Engine, extraFiles: readonly string[]): Promise<void> {
  await ensureFresh($, extraFiles)
  syncStatus($, extraFiles)
  if (!state.ready) throw new IndexNotReady()
}

/** Random-looking values a rule found (a token under `'token' =>`) are known from now on, also where they appear bare. */
function learn(found: ReadonlyMap<string, string>): void {
  let added = false
  for (const [value, name] of found) {
    if (state.learned.size >= LEARN_MAX) break
    if (state.learned.has(value) || state.idx.byValue.has(value) || !isKnownCandidate(value, false)) continue
    state.learned.set(value, name)
    added = true
  }
  if (added) rebuild(state.sources)
}

function redact(text: string): string {
  if (state.fault) throw new Error('secrets-redact fault injection (SECRETS_REDACT_FAULT_INJECT=1)')
  const found = new Map<string, string>()
  const out = redactText(text, state.idx, found)
  learn(found)
  return out
}

function markDone(id: string | undefined) {
  if (id === undefined) return
  if (state.done.size > 5000) state.done.clear()
  state.done.add(id)
}

function errorName(error: { readonly kind: string; readonly message?: string }): string {
  return /\b([A-Z]\w*(?:Error|NotReady))\b/.exec(error.message ?? '')?.[1] ?? error.kind
}

/** The notice that stands in for a result redaction failed on, in a shape the tool's schema takes. */
function hiddenResult(tool: string, e: Record<string, unknown>, note: string): ToolCallResult {
  if (tool === 'Bash') return { result: { stdout: note, stderr: '', interrupted: false } }
  if (tool === 'Read' && typeof e.file_path === 'string') {
    return { result: { type: 'text', file: { filePath: e.file_path, content: note, numLines: 1, startLine: 1, totalLines: 1 } } }
  }
  return { deny: `${note}. The tool did run; only its output is hidden.` }
}

const failNote = (name: string) => `output hidden: secrets-redact failed (${name})`

/**
 * The redacted answer for a tool call that ran. The result's own record is
 * rewritten; `context` entries a tool attached cannot be (core refuses a hook
 * that drops one), so they are left to the session.append backstop, which sees
 * the rows they become.
 */
async function redactRan($: Engine, extraFiles: readonly string[], id: string | undefined, tool: string, input: Record<string, unknown>, ran: ToolCallResult): Promise<ToolCallResult> {
  await ready($, extraFiles)
  if (state.fault) redact('')

  if (tool === 'Read' && ran.isError === undefined) {
    const kind = credentialFileKind(String(input.file_path ?? ''))
    const rec = ran.result as { type?: string; file?: Record<string, unknown> } | undefined
    if (kind !== undefined && rec?.type === 'text' && rec.file) {
      markDone(id)
      const content = credentialNotice(String(input.file_path), kind)
      return { result: { ...rec, file: { ...rec.file, content, numLines: 1, startLine: 1, totalLines: 1 } }, ...(ran.context && { context: ran.context }) }
    }
  }

  const found = new Map<string, string>()
  if (ran.isError === true) {
    // An errored call's answer is core's alone (a hook's own isError is checked
    // against the tool's output schema and refused), so a secret in its text is
    // answered as a deny: the model reads the redacted text as an error result.
    const text = redactText(ran.text ?? (typeof ran.result === 'string' ? ran.result : ''), state.idx, found)
    const res = redactDeep(ran.result, state.idx, found)
    learn(found)
    markDone(id)
    if (!res.changed && text === (ran.text ?? text)) return ran
    return { deny: text || 'the tool failed; its error text is hidden by secrets-redact' }
  }
  const res = redactDeep(ran.result, state.idx, found)
  learn(found)
  // An MCP tool's record has no schema here: its row is left to the session.append backstop as well.
  if (!tool.startsWith('mcp__')) markDone(id)
  if (!res.changed) return ran
  return { result: res.value, ...(ran.context && { context: ran.context }) }
}

/** The status-line note when part of what should be known is not: no extraFiles, a missing one, no index yet. */
function sourceWarning(extraFiles: readonly string[]): string | undefined {
  if (!state.ready) return `secrets-redact: no index yet${state.lastError ? ` (${state.lastError})` : ''}, tool output is hidden until it builds`
  if (extraFiles.length === 0) return 'secrets-redact: no extraFiles set, access notes are not known values'
  if (state.missingExtra > 0) return `secrets-redact: ${state.missingExtra} of ${extraFiles.length} extraFiles missing`
  return undefined
}

/**
 * A failing mod is skipped silently (the debug log alone says so), and with block-secrets gone nothing else would
 * hide a value. So the mod leaves a file per session it serves, and `guard/alive.sh`, a classic PreToolUse hook outside
 * the engine, denies every tool call of a session that has none. Written at start and at every prompt (a /clear
 * changes the session id without a new session.start), before any tool call of that turn.
 */
async function beat($: Engine): Promise<void> {
  const id = await $.session.id()
  if (state.beaten.has(id)) return
  await ensureHome($)
  if (!state.home) return
  await $.fs.write(`${state.home}/.claude/state/secrets-redact/alive/${id}`, `${new Date().toISOString()}\n`)
  state.beaten.add(id)
}

/** Shows the current source warning, or clears the old one, whenever it changed. */
function syncStatus($: Engine, extraFiles: readonly string[]): void {
  const warning = sourceWarning(extraFiles)
  if (warning === state.shown) return
  state.shown = warning
  try {
    $.ui.status(warning)
  } catch {
    // a session that draws nowhere has no status line
  }
}

export const register: Register = (on, options) => {
  const extraFiles = Array.isArray(options.extraFiles) ? options.extraFiles.filter(f => typeof f === 'string' && f.trim() !== '') : []

  on('session.start', async ($, e, next) => {
    await beat($).catch(() => undefined)
    await ensureFresh($, extraFiles).catch(() => undefined)
    syncStatus($, extraFiles)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    await ensureHome($)
    if (!NO_SINK_TOOLS.has(tool) && inputHasPlaceholder(input)) return { deny: PLACEHOLDER_DENY }

    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    try {
      return await redactRan($, extraFiles, e.tool_use_id, tool, input, ran)
    } catch (err) {
      // Our own failure (no index yet included): hide the output under the
      // error's name. A timeout lands in .catch below, which hides it too.
      return hiddenResult(tool, input, failNote(err instanceof Error ? err.name : 'Error'))
    }
  }).catch(($, e, next) => {
    if (!next.called) return { deny: `secrets-redact failed before the tool ran (${errorName(next.error)}); nothing ran, retry the call` }
    return hiddenResult(String(e.tool), e as unknown as Record<string, unknown>, failNote(errorName(next.error)))
  })

  // A submission the owner did not type (a Monitor event, a task notification,
  // a peer's or a channel's message) before it is queued and recorded.
  on('prompt.submit', async ($, e, next) => {
    await beat($).catch(() => undefined)
    if (OWNER_ORIGINS.has(e.origin.kind)) return next(e)
    await ready($, extraFiles)
    const text = redact(e.text)
    const context = e.context?.map(c => redact(c))
    const same = text === e.text && (context === undefined || context.every((c, i) => c === e.context![i]))
    return same ? next(e) : next({ ...e, text, ...(context && { context }) })
  }).catch(($, e, next) => {
    if (next.called || OWNER_ORIGINS.has(e.origin.kind)) return undefined
    const note = failNote(errorName(next.error))
    return next({ ...e, text: note, ...(e.context && { context: e.context.map(() => note) }) })
  })

  // A delivery (a relay's event, a peer's message, a schedule) before it is
  // queued; the owner's own Remote Control message is left as typed.
  on('session.receive', async ($, e, next) => {
    if (e.origin.kind === 'bridge') return next(e)
    await ready($, extraFiles)
    const text = redact(e.text)
    return text === e.text ? next(e) : next({ ...e, text })
  }).catch(($, e, next) => {
    if (next.called) return undefined
    return next({ ...e, text: failNote(errorName(next.error)) })
  })

  // Backstop: every row the model reads that did not pass through tool.call,
  // prompts included (a Monitor event, a stalled shell's output, a peer's or a
  // channel's message arrive as prompts); only what the owner typed and the
  // model's own response are left alone.
  on('session.append', { door: ['prompt', 'command', 'tool-result', 'tool-message', 'delivery', 'attachment', 'hook-context', 'note', 'compaction', 'notice'] }, async ($, e, next) => {
    if (e.door === 'prompt' && OWNER_ORIGINS.has(String((e.origin as { kind?: unknown }).kind))) return next(e)
    await ready($, extraFiles)
    // The Read tool recorded a credential file whose answer tool.call replaced, so the engine may render it again
    // as an attachment; that copy is hidden whole as well.
    if (e.message.name === 'file' || e.message.name === 'edited_text_file') {
      const text = e.message.content.map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
      const cred = credentialPathIn(text)
      if (cred !== undefined) {
        const notice = credentialNotice(cred.path, cred.kind)
        return next({ ...e, message: { ...e.message, content: e.message.content.map(b => (b.type === 'text' ? { ...b, text: notice } : b)) } })
      }
    }
    let changed = false
    const content = e.message.content.map(block => {
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = redact(block.text)
        if (text === block.text) return block
        changed = true
        return { ...block, text }
      }
      if (block.type === 'tool_result') {
        if (typeof block.tool_use_id === 'string' && state.done.delete(block.tool_use_id)) return block
        if (state.fault) redact('')
        const found = new Map<string, string>()
        const r = redactDeep(block.content, state.idx, found)
        learn(found)
        if (!r.changed) return block
        changed = true
        return { ...block, content: r.value }
      }
      return block
    })
    return changed ? next({ ...e, message: { ...e.message, content } }) : next(e)
  }).catch(($, e, next) => {
    if (next.called) return undefined
    const note = failNote(errorName(next.error))
    const content = e.message.content.map(block =>
      block.type === 'text' ? { ...block, text: note } : block.type === 'tool_result' ? { ...block, content: note } : block)
    return next({ ...e, message: { ...e.message, content } })
  })
}
