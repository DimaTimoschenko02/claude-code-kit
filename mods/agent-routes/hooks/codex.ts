// Pure: does a Bash command launch `codex exec` without full access or on an outdated model, and the same command fixed.
// The owner runs Codex with `-s danger-full-access` always, on the newest model of its family in the Codex catalog
// (the family is the routing rule, the version is not ours to pin); a launch that breaks either is refused with the
// fixed command. Only a segment whose own command word is `codex` counts: a heredoc body, `echo … > f`, a grep
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
/** A run on a local provider takes no catalog model: its model is never checked. */
const LOCAL_FLAGS = new Set(['--oss', '--local-provider'])

/** The family a launch with no model gets: the one every Codex role runs (codex-roles' CODEX_FAMILY). */
export const DEFAULT_FAMILY = 'sol'
/** A catalog slug: `gpt-<n(.n)*>-<family>`; a preview (`gpt-7-sol-preview`) or `gpt-reserve` never matches. */
const SLUG = /^gpt-(\d+(?:\.\d+)*)-([a-z]+)$/

/** The visible slugs of Codex's `models_cache.json` (`models[]`, `visibility === "list"`); null when unreadable. */
export function parseCatalog(text: string): string[] | null {
  try {
    const { models } = JSON.parse(text.replace(/^\uFEFF/, '')) as { models?: unknown }
    if (!Array.isArray(models)) return null
    return models
      .filter((m): m is { slug: string } => m?.visibility === 'list' && typeof m?.slug === 'string')
      .map(m => m.slug)
  } catch {
    return null
  }
}

const parseSlug = (slug: string): { version: number[]; family: string } | null => {
  const m = SLUG.exec(slug)
  return m ? { version: m[1]!.split('.').map(Number), family: m[2]! } : null
}

/** Numeric, part by part: 6.10 > 6.2, 6.1 > 6. */
const newer = (a: number[], b: number[]): boolean => {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}

/** The newest catalog slug of a family; null when the family is absent. */
export function newestOf(catalog: readonly string[], family: string): string | null {
  let best: { slug: string; version: number[] } | null = null
  for (const slug of catalog) {
    const p = parseSlug(slug)
    if (p && p.family === family && (!best || newer(p.version, best.version))) best = { slug, version: p.version }
  }
  return best?.slug ?? null
}

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

/** A model the launch names (`-m X`, `--model X`, `-m=X`, `--model=X`, `-mX`): the word that carries it and its prefix. */
type ModelArg = { slug: string; prefix: string; word: Word }

/**
 * A `codex exec` launch in one segment: what is wrong with its sandbox and model and the edits that fix both;
 * null if fine. With no catalog the model is not checked.
 */
function judgeSegment(
  text: string,
  words: Word[],
  catalog: readonly string[] | null,
): { problem: string | null; models: string[]; edits: Edit[] } | null {
  const found = execOf(words)
  if (!found) return null
  const { args, execAt } = found

  // The model: named by a flag (checked against the catalog), chosen elsewhere (profile, `-c model=`, a local
  // provider: left alone) or not at all (Codex would take config.toml's default, which the Codex app rewrites).
  const named: ModelArg[] = []
  let chosenElsewhere = false
  for (let i = 0; i < args.length; i += 1) {
    const v = args[i]!.value
    if (v === '--') break
    if (v === '-m' || v === '--model') {
      if (args[i + 1]) named.push({ slug: args[i + 1]!.value, prefix: '', word: args[i + 1]! })
      i += 1
    } else if (v.startsWith('--model=')) named.push({ slug: v.slice('--model='.length), prefix: '--model=', word: args[i]! })
    else if (/^-m./.test(v)) {
      const prefix = v[2] === '=' ? '-m=' : '-m'
      named.push({ slug: v.slice(prefix.length), prefix, word: args[i]! })
    } else if (v === '-p' || v === '--profile' || v.startsWith('--profile=') || LOCAL_FLAGS.has(v)) {
      chosenElsewhere = true
      if (v === '-p' || v === '--profile' || v === '--local-provider') i += 1
    } else if (v === '-c' || v === '--config' || v.startsWith('--config=')) {
      const inline = v.startsWith('--config=')
      const kv = inline ? v.slice('--config='.length) : (args[i + 1]?.value ?? '')
      if (/^\s*model\s*=/.test(kv)) chosenElsewhere = true
      if (!inline) i += 1
    } else if (VALUE_FLAGS.has(v)) i += 1
  }
  const models: string[] = []
  const modelEdits: Edit[] = []
  let addModel: string | null = null
  if (catalog && !chosenElsewhere) {
    if (named.length === 0) {
      addModel = newestOf(catalog, DEFAULT_FAMILY)
      if (addModel) models.push(`модель не задана (Codex взял бы дефолт из config.toml) → \`-m ${addModel}\`, новейшая ${DEFAULT_FAMILY} в каталоге Codex`)
    }
    for (const m of named) {
      const p = parseSlug(m.slug)
      const best = p ? newestOf(catalog, p.family) : null
      const bp = best ? parseSlug(best) : null
      if (!p || !best || !bp || !newer(bp.version, p.version)) continue
      models.push(`\`${m.slug}\` устарела → \`${best}\`, новейшая ${p.family} в каталоге Codex`)
      modelEdits.push({ start: m.word.start, end: m.word.end, text: `${m.prefix}${best}` })
    }
  }

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
  const sandboxOk = bad.length === 0 && hasFull
  if (sandboxOk && models.length === 0) return null

  const edits: Edit[] = bad.map(b => {
    let from = args[b.from]!.start
    while (from > 0 && (text[from - 1] === ' ' || text[from - 1] === '\t')) from -= 1
    return { start: from, end: args[b.to]!.end, text: '' }
  })
  edits.push(...modelEdits)
  // One insertion right after `exec`, sandbox first: two at one offset would come out in either order.
  const insert = `${hasFull ? '' : ` -s ${FULL}`}${addModel ? ` -m ${addModel}` : ''}`
  if (insert) {
    const at = args[execAt]!.end
    edits.push({ start: at, end: at, text: insert })
  }
  const problem = sandboxOk ? null : bad.length > 0 ? bad.map(b => b.problem).join(', ') : 'без флага sandbox'
  return { problem, models, edits }
}

/** What is wrong with a command's `codex exec` launches and the whole command fixed. */
export type CodexFix = { problems: string[]; models: string[]; fixed: string }

/**
 * Every `codex exec` launch in the command, judged on sandbox and, with a catalog, on model: the sandbox problems,
 * the model changes and the whole command fixed. Null when nothing is wrong. A null catalog checks the sandbox only.
 */
export function codexFix(command: string, catalog: readonly string[] | null = null): CodexFix | null {
  if (!command.includes('codex')) return null
  const text = command.length > MAX_SCAN ? command.slice(0, MAX_SCAN) : command
  const problems: string[] = []
  const models: string[] = []
  const edits: Edit[] = []
  for (const words of segments(text)) {
    const r = judgeSegment(text, words, catalog)
    if (!r) continue
    if (r.problem) problems.push(r.problem)
    models.push(...r.models)
    edits.push(...r.edits)
  }
  if (problems.length === 0 && models.length === 0) return null
  let fixed = command
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) {
    fixed = fixed.slice(0, e.start) + e.text + fixed.slice(e.end)
  }
  return { problems, models, fixed }
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

/** The deny the model reads: the rules broken, what was wrong, the command to run instead (bounded). */
export function codexReason(fix: CodexFix): string {
  const { problems, models, fixed } = fix
  const shown = fixed.length <= 4000 ? fixed : `${fixed.slice(0, 4000)}\n… (дальше без изменений)`
  const rules = [
    ...(problems.length > 0 ? [`с полным доступом \`-s ${FULL}\``] : []),
    ...(models.length > 0 ? ['на новейшей модели своего семейства из каталога Codex (Astra остаётся Astra, Sol — Sol)'] : []),
  ]
  return [
    `agent-routes (a mod the owner installed): Codex у владельца — всегда ${rules.join(' и ')}; тут ${[...problems, ...models].join('; ')}. Запусти так:`,
    '```bash',
    shown,
    '```',
  ].join('\n')
}
