// Pure parts of run-loop-hint: which Bash commands are "runs", the hint text, the fire log line, the runner pick.

/** A command longer than this is judged on its head: a run sits at the start or right after a heredoc. */
const MAX_SCAN = 64 * 1024

const ALWAYS = new Set(['npx', 'tsx', 'vitest', 'ffmpeg', 'blender'])
const NPM_RUN = new Set(['run', 'run-script', 'test', 't', 'tst', 'exec', 'x'])
const PNPM_NOT_RUN = new Set(['install', 'i', 'add', 'remove', 'rm', 'un', 'uninstall', 'update', 'up', 'link', 'store', 'config', 'env', 'outdated', 'list', 'ls', 'why'])
const NODE_NOT_RUN = new Set(['-e', '--eval', '-p', '--print', '-v', '--version', '-h', '--help', '-c', '--check'])
const PY_NOT_RUN = new Set(['-c', '-V', '--version', '-h', '--help'])
const PY_TOOL_MODULES = new Set(['json.tool', 'pip', 'venv', 'ensurepip', 'http.server'])
const WRAPPERS = new Set(['time', 'nice', 'command', 'exec', 'nohup', 'stdbuf'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const HEREDOC = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/

/** The command's own name: basename, lower-cased, Windows suffix off (`C:/Py/python.exe` → `python`). */
function commandName(token: string): string {
  const bare = token.replace(/^['"]+|['"]+$/g, '')
  const base = bare.slice(Math.max(bare.lastIndexOf('/'), bare.lastIndexOf('\\')) + 1).toLowerCase()
  return base.replace(/\.(exe|cmd|bat)$/, '')
}

/** Tokens of one segment with leading assignments, `env`, `timeout N` and wrappers such as `time` dropped. */
function commandTokens(segment: string): string[] {
  const tokens = segment.trim().replace(/^[({!\s]+/, '').split(/\s+/).filter(t => t !== '')
  let i = 0
  while (i < tokens.length) {
    const t = tokens[i] ?? ''
    const name = commandName(t)
    if (ASSIGNMENT.test(t) || WRAPPERS.has(name)) i += 1
    else if (name === 'env') {
      i += 1
      while (i < tokens.length && (ASSIGNMENT.test(tokens[i] ?? '') || (tokens[i] ?? '').startsWith('-'))) i += 1
    } else if (name === 'timeout') {
      i += 1
      while (i < tokens.length && (tokens[i] ?? '').startsWith('-')) i += 1
      i += 1
    } else break
  }
  return tokens.slice(i)
}

/** Reads its script from stdin: `node <<EOF`, `python3 < probe.py`. */
const readsStdin = (segment: string): boolean => /<</.test(segment) || /(^|[^<\d&])<\s*[^\s<(]/.test(segment)

function nodeIsRun(args: string[], segment: string): boolean {
  for (const a of args) {
    if (NODE_NOT_RUN.has(a)) return false
    if (a === '-' || a === '--test' || !a.startsWith('-')) return true
  }
  return readsStdin(segment)
}

function pythonIsRun(args: string[], segment: string): boolean {
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i] ?? ''
    if (PY_NOT_RUN.has(a)) return false
    if (a === '-m') return !PY_TOOL_MODULES.has(args[i + 1] ?? '')
    if (a === '-' || !a.startsWith('-')) return true
  }
  return readsStdin(segment)
}

/** One command segment (no `&&`, `|`, `;` inside) is a run: a script, a test, a probe, a render, a CI watch. */
export function segmentIsRun(segment: string): boolean {
  const tokens = commandTokens(segment)
  const head = tokens[0]
  if (head === undefined) return false
  const name = commandName(head)
  const args = tokens.slice(1)
  const verb = args.find(a => !a.startsWith('-'))

  if (ALWAYS.has(name)) return true
  if (/\.sh$/i.test(head) && name !== 'sh') return true
  if (name === 'npm') return args.slice(0, 4).some(a => NPM_RUN.has(a))
  if (name === 'pnpm') return verb !== undefined && !PNPM_NOT_RUN.has(verb)
  if (name === 'node') return nodeIsRun(args, segment)
  if (/^(python[0-9.]*|py)$/.test(name)) return pythonIsRun(args, segment)
  if (name === 'bash' || name === 'sh' || name === 'zsh') {
    const inline = args.findIndex(a => /^-[a-z]*c$/.test(a))
    if (inline >= 0) return segmentIsRun(args.slice(inline + 1).join(' ').replace(/^['"]|['"]$/g, ''))
    return verb !== undefined && /\.sh$/i.test(verb)
  }
  if (name === 'gh') return (args[0] === 'run' && args[1] === 'watch') || (args[0] === 'pr' && args[1] === 'checks' && args.includes('--watch'))
  if (name === 'pwsh' || name === 'powershell') return args.some(a => /^-f(ile)?$/i.test(a))
  return false
}

/**
 * A Bash call is a run when any of its segments is. Split on `&&`, `||`, `;`, `|`, `&` and newlines; a heredoc's body
 * is data, not commands, and is skipped (the line that opens it is judged: `python3 - <<'EOF'`).
 */
export function isRun(command: string): boolean {
  const text = command.length > MAX_SCAN ? command.slice(0, MAX_SCAN) : command
  let delimiter: string | undefined
  for (const line of text.split('\n')) {
    if (delimiter !== undefined) {
      if (line.trim() === delimiter) delimiter = undefined
      continue
    }
    for (const segment of line.split(/&&|\|\||[;|&]/)) {
      if (segmentIsRun(segment)) return true
    }
    delimiter = HEREDOC.exec(line)?.[2]
  }
  return false
}

/** The runner agent's name for the hint: its frontmatter `name`, else the file stem; only a plain slug passes. */
export function runnerName(fileName: string, content: string | undefined): string | undefined {
  const stem = fileName.replace(/\.md$/i, '')
  const front = content?.startsWith('---') ? content.slice(0, 2000).split(/\r?\n---/)[0] : undefined
  const declared = front?.match(/^name:\s*['"]?([^'"\r\n]+?)['"]?\s*$/m)?.[1]
  const slug = /^[A-Za-z0-9_-]{1,64}$/
  if (declared !== undefined && slug.test(declared)) return declared
  return slug.test(stem) ? stem : undefined
}

/** The first `*-runner.md` of a listing, by name so the pick is stable. */
export function pickRunnerFile(names: readonly string[]): string | undefined {
  return [...names].filter(n => /-runner\.md$/i.test(n)).sort()[0]
}

/** Every directory from `cwd` up to the root, nearest first (`C:/a/b` → `C:/a/b`, `C:/a`, `C:/`). */
export function ancestors(cwd: string): string[] {
  const path = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const out: string[] = []
  let dir = path === '' ? '/' : path
  for (let guard = 0; guard < 64; guard += 1) {
    out.push(dir)
    const cut = dir.lastIndexOf('/')
    if (cut < 0) break
    const parent = cut === 0 ? '/' : dir.slice(0, cut)
    const isDriveRoot = /^[A-Za-z]:$/.test(parent)
    const next = isDriveRoot ? `${parent}/` : parent
    if (next === dir || dir === '/' || /^[A-Za-z]:\/$/.test(dir)) break
    dir = next
  }
  return out
}

/** The one line the model reads after the Nth run in a row. */
export function hintText(count: number, runner: string | undefined): string {
  const loop = 'If the next steps are more "run → read numbers → rerun", hand the loop'
  const where =
    runner === undefined
      ? `${loop} to \`general-purpose\` with model: sonnet (the commands and the numbers to extract), or to a Codex run.`
      : `${loop} to the \`${runner}\` agent with the commands and the numbers to extract; otherwise to \`general-purpose\` with model: sonnet, or a Codex run.`
  return `run-loop-hint (a mod the owner installed): ${count} run commands in a row on the main context. ${where} Skip this if each run needs your own judgement.`
}

/** One fire as a log line: ISO time, session id, cwd, count — tab-separated, cwd may hold spaces. */
export function logLine(iso: string, sessionId: string, cwd: string, count: number): string {
  const flat = (s: string) => s.replace(/[\t\r\n]+/g, ' ')
  return `${iso}\t${flat(sessionId)}\t${flat(cwd)}\t${count}\n`
}

/** The log with one line added, its oldest lines dropped past `cap` bytes so it never nears the 4 MiB read limit. */
export function appendBounded(old: string, line: string, cap = 1024 * 1024): string {
  const text = old + line
  if (text.length <= cap) return text
  const tail = text.slice(text.length - Math.floor(cap / 2))
  return tail.slice(tail.indexOf('\n') + 1)
}
