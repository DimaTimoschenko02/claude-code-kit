// Pure: does a Bash command launch `codex exec` without full access, and the same command fixed.
// The owner runs Codex with `-s danger-full-access` always; a launch with a narrower or no sandbox is refused with
// the fixed command. Only a segment whose own command word is `codex` counts: a heredoc body, `echo … > f`, a grep
// for the string, or a script run by name (`bash .claude/bin/x.sh`) is not a launch.

/** A command longer than this is judged on its head: a launch sits at the start or right after a heredoc. */
const MAX_SCAN = 64 * 1024
const FULL = 'danger-full-access'

/** A word with its unquoted value and its span in the original text. */
type Word = { value: string; start: number; end: number }

const WRAPPERS = new Set(['time', 'nice', 'command', 'exec', 'nohup', 'stdbuf'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
/** Codex flags that take a value as the next word: their value is never the subcommand. */
const VALUE_FLAGS = new Set([
  '-c', '--config', '-m', '--model', '-p', '--profile', '-C', '--cd', '-i', '--image', '-s', '--sandbox', '-a',
  '--ask-for-approval', '--enable', '--disable', '-o', '--output-last-message', '--output-schema', '--color',
  '--add-dir', '--local-provider',
])
const FULL_FLAGS = new Set(['--dangerously-bypass-approvals-and-sandbox', '--yolo'])

/**
 * Splits a command into simple-command segments of words, quote-aware: `;`, `&`, `&&`, `|`, `||`, `(`, `)`, a
 * backtick and a newline end a segment; a heredoc's body is skipped; `# …` is a comment. Offsets index `text`.
 */
export function segments(text: string): Word[][] {
  const out: Word[][] = []
  let seg: Word[] = []
  let value = ''
  let start = -1
  let quote: '' | "'" | '"' = ''
  const pending: { delim: string; strip: boolean }[] = []

  const endWord = (at: number) => {
    if (start >= 0) seg.push({ value, start, end: at })
    value = ''
    start = -1
  }
  const endSeg = (at: number) => {
    endWord(at)
    if (seg.length > 0) out.push(seg)
    seg = []
  }

  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (quote === "'") {
      if (c === "'") quote = ''
      else value += c
      i += 1
      continue
    }
    if (quote === '"') {
      if (c === '"') quote = ''
      else if (c === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1]!)) {
        value += text[i + 1]
        i += 1
      } else value += c
      i += 1
      continue
    }
    if (c === "'" || c === '"') {
      if (start < 0) start = i
      quote = c
      i += 1
      continue
    }
    if (c === '\\') {
      if (text[i + 1] === '\n') {
        i += 2
        continue
      }
      if (start < 0) start = i
      if (i + 1 < text.length) value += text[i + 1]
      i += 2
      continue
    }
    if (c === '#' && start < 0) {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<' && text[i - 1] !== '<') {
      endWord(i)
      let j = i + 2
      const strip = text[j] === '-'
      if (strip) j += 1
      while (text[j] === ' ' || text[j] === '\t') j += 1
      const m = /^(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(text.slice(j, j + 80))
      if (m) {
        pending.push({ delim: m[2]!, strip })
        i = j + m[0].length
        continue
      }
      i += 2
      continue
    }
    if (c === '\n') {
      endSeg(i)
      i += 1
      // Heredoc bodies opened on this line: data, skipped up to each terminator line.
      while (pending.length > 0) {
        const { delim } = pending.shift()!
        while (i < text.length) {
          const nl = text.indexOf('\n', i)
          const line = text.slice(i, nl < 0 ? text.length : nl)
          i = nl < 0 ? text.length : nl + 1
          if (line.trim() === delim) break
        }
      }
      continue
    }
    if (c === '$' && text[i + 1] === '(') {
      endSeg(i)
      i += 2
      continue
    }
    if (c === '&' && (text[i - 1] === '>' || text[i - 1] === '<' || text[i + 1] === '>')) {
      if (start < 0) start = i
      value += c
      i += 1
      continue
    }
    if (c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '`') {
      endSeg(i)
      i += 1
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord(i)
      i += 1
      continue
    }
    if (start < 0) start = i
    value += c
    i += 1
  }
  endSeg(text.length)
  return out
}

/** The command's own name: basename, lower-cased, Windows suffix off (`C:/bin/codex.cmd` → `codex`). */
function commandName(token: string): string {
  const base = token.slice(Math.max(token.lastIndexOf('/'), token.lastIndexOf('\\')) + 1).toLowerCase()
  return base.replace(/\.(exe|cmd|bat|ps1)$/, '')
}

/** Index of the segment's command word, past assignments, `env …`, `timeout N` and wrappers such as `nohup`. */
function headIndex(words: Word[]): number {
  let i = 0
  while (i < words.length) {
    const t = words[i]!.value
    const name = commandName(t)
    if (ASSIGNMENT.test(t) || WRAPPERS.has(name)) i += 1
    else if (name === 'env') {
      i += 1
      while (i < words.length && (ASSIGNMENT.test(words[i]!.value) || words[i]!.value.startsWith('-'))) i += 1
    } else if (name === 'timeout') {
      i += 1
      while (i < words.length && words[i]!.value.startsWith('-')) i += 1
      i += 1
    } else break
  }
  return i
}

type Edit = { start: number; end: number; text: string }

/** The segment's `codex exec`: its arguments and where `exec` sits in them; null when the segment launches no exec. */
function execOf(words: Word[]): { args: Word[]; execAt: number } | null {
  const h = headIndex(words)
  if (h >= words.length || commandName(words[h]!.value) !== 'codex') return null
  const args = words.slice(h + 1)
  for (let i = 0; i < args.length; i += 1) {
    const v = args[i]!.value
    if (v.startsWith('-')) {
      if (VALUE_FLAGS.has(v)) i += 1
      continue
    }
    return v === 'exec' || v === 'e' ? { args, execAt: i } : null
  }
  return null
}

/** A `codex exec` launch in one segment: what is wrong with its sandbox and the edits that fix it; null if fine. */
function judgeSegment(text: string, words: Word[]): { problem: string; edits: Edit[] } | null {
  const found = execOf(words)
  if (!found) return null
  const { args, execAt } = found

  const bad: { problem: string; from: number; to: number }[] = []
  let hasFull = false
  for (let i = 0; i < args.length; i += 1) {
    const w = args[i]!
    const v = w.value
    if (v === '--') break
    if (FULL_FLAGS.has(v)) hasFull = true
    else if (v === '--full-auto') bad.push({ problem: '`--full-auto` (это workspace-write)', from: i, to: i })
    else if (v === '-s' || v === '--sandbox' || v.startsWith('--sandbox=')) {
      const inline = v.startsWith('--sandbox=')
      const mode = inline ? v.slice('--sandbox='.length) : (args[i + 1]?.value ?? '')
      if (mode === FULL) hasFull = true
      else bad.push({ problem: `\`${v}${inline ? '' : ` ${mode}`}\``, from: i, to: inline ? i : i + 1 })
      if (!inline) i += 1
    } else if (v === '-c' || v === '--config' || v.startsWith('--config=')) {
      const inline = v.startsWith('--config=')
      const kv = inline ? v.slice('--config='.length) : (args[i + 1]?.value ?? '')
      const m = /^\s*sandbox_mode\s*=\s*(.*)$/.exec(kv)
      if (m) {
        const mode = m[1]!.trim().replace(/^(['"])(.*)\1$/, '$2')
        if (mode === FULL) hasFull = true
        else bad.push({ problem: `\`-c sandbox_mode=${mode}\``, from: i, to: inline ? i : i + 1 })
      }
      if (!inline) i += 1
    } else if (VALUE_FLAGS.has(v)) i += 1
  }
  if (bad.length === 0 && hasFull) return null

  const edits: Edit[] = bad.map(b => {
    let from = args[b.from]!.start
    while (from > 0 && (text[from - 1] === ' ' || text[from - 1] === '\t')) from -= 1
    return { start: from, end: args[b.to]!.end, text: '' }
  })
  if (!hasFull) {
    const at = args[execAt]!.end
    edits.push({ start: at, end: at, text: ` -s ${FULL}` })
  }
  const problem = bad.length > 0 ? bad.map(b => b.problem).join(', ') : 'без флага sandbox'
  return { problem, edits }
}

/** A `codex exec` launch without full access: the problems found and the whole command fixed. Null when none. */
export function codexSandboxFix(command: string): { problems: string[]; fixed: string } | null {
  if (!command.includes('codex')) return null
  const text = command.length > MAX_SCAN ? command.slice(0, MAX_SCAN) : command
  const problems: string[] = []
  const edits: Edit[] = []
  for (const words of segments(text)) {
    const r = judgeSegment(text, words)
    if (!r) continue
    problems.push(r.problem)
    edits.push(...r.edits)
  }
  if (problems.length === 0) return null
  let fixed = command
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    fixed = fixed.slice(0, e.start) + e.text + fixed.slice(e.end)
  }
  return { problems, fixed }
}

/** Does any segment of the command launch `codex exec` (a `grep 'codex exec'` or `codex --version` does not). */
export function launchesCodexExec(command: string): boolean {
  if (!command.includes('codex')) return false
  const text = command.length > MAX_SCAN ? command.slice(0, MAX_SCAN) : command
  return segments(text).some(words => execOf(words) !== null)
}

/** The deny for a raw launch in a project that starts Codex through its own launcher. */
export function launcherReason(launcher: string): string {
  return [
    'agent-routes (a mod the owner installed): в этом проекте Codex запускается не голым `codex exec`, а запускателем проекта —',
    'в нём проверки и журнал, которых у прямого запуска нет (`codexLauncher` в .claude/agent-routes.json). Запусти так:',
    '```bash',
    launcher,
    '```',
  ].join('\n')
}

/** The deny the model reads: the rule, what was wrong, the command to run instead (bounded). */
export function codexReason(problems: string[], fixed: string): string {
  const shown = fixed.length <= 4000 ? fixed : `${fixed.slice(0, 4000)}\n… (дальше без изменений)`
  return [
    `agent-routes (a mod the owner installed): Codex у владельца — всегда с полным доступом \`-s ${FULL}\`; тут ${problems.join('; ')}. Запусти так:`,
    '```bash',
    shown,
    '```',
  ].join('\n')
}
