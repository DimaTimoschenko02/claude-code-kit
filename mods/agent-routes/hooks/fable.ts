// Pure: does a shell command start a new Claude session on Fable. Only the owner starts Fable sessions; an agent may
// use Fable as a subagent (Agent `model: fable`, a Workflow `agent()`), never as a whole session. A launch is a word
// that is the `claude` binary in a segment that runs it: text that merely names Fable (an echo, a grep, a commit
// message, a heredoc body, a file write) is data. Nested shells (`bash -c`, `ssh host '…'`, `cmd /c`, `pwsh -Command`)
// and `$(…)` / backtick substitutions inside double quotes are read too.

import { ASSIGNMENT, commandName, headIndex, segments, type Word } from './codex'

const MAX_SCAN = 64 * 1024
const MAX_DEPTH = 4

/** Commands whose arguments are data: a `claude --model fable` among them is text, not a launch. */
const DATA_HEADS = new Set([
  'echo', 'printf', 'print', 'write-output', 'write-host', 'grep', 'egrep', 'fgrep', 'rg', 'git', 'gh', 'cat', 'head',
  'tail', 'sed', 'awk', 'jq', 'less', 'more', 'man', 'which', 'type', 'where', 'whereis', 'wc', 'sort', 'uniq', 'test',
  '[', 'true', 'false', ':', 'obsidian', 'select-string', 'tee', 'cut', 'tr', 'diff',
])
/** Commands that run a later argument as a command line: that argument is read as a command too. */
const RUNNERS = new Set([
  'bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh', 'eval', 'ssh', 'wsl', 'su', 'script',
  'sudo', 'doas', 'setsid', 'caffeinate', 'xargs', 'watch', 'start', 'start-process', 'saps', 'find', 'npx', 'bunx',
  'pnpx', 'pnpm', 'yarn', 'exec', 'nohup', 'timeout', 'env', 'command',
])
const CLAUDE = new Set(['claude', 'claude-code'])
/** `Start-Process claude -ArgumentList '--model fable'`: its arguments arrive as one word. */
const SPLIT_ARGS = new Set(['start', 'start-process', 'saps'])
/** `claude <subcommand>` manages, it does not open a session: only an explicit Fable flag counts there. */
const SUBCOMMANDS = new Set([
  'agents', 'attach', 'auth', 'auto-mode', 'config', 'doctor', 'gateway', 'import', 'install', 'logs', 'mcp', 'plugin',
  'plugins', 'purge', 'respawn', 'rm', 'setup-token', 'stop', 'kill', 'ultrareview', 'update', 'upgrade', 'migrate-installer',
])
/** Claude flags whose value is the next word (so that word is neither a prompt nor a subcommand). */
const VALUE_FLAGS = new Set([
  '--add-dir', '--append-system-prompt', '--append-system-prompt-file', '--system-prompt', '--system-prompt-file',
  '--autocompact', '--betas', '--debug-file', '--effort', '--environment', '--file', '--input-format', '--json-schema',
  '--max-budget-usd', '--max-turns', '--mcp-config', '-n', '--name', '--output-format', '--permission-mode',
  '--permission-prompts', '--plugin-dir', '--plugin-url', '--remote-control-session-name-prefix', '--session-id',
  '--setting-sources', '--system-prompt-snapshot', '--tools', '--allowedTools', '--allowed-tools', '--disallowedTools',
  '--disallowed-tools',
])
/** Environment variables that pick the session's model (or what an alias resolves to). */
const MODEL_ENV = /^ANTHROPIC_(MODEL|SMALL_FAST_MODEL|DEFAULT_[A-Z0-9_]+_MODEL)$/

export const isFable = (model: unknown): boolean => /fable/i.test(String(model ?? ''))

/** One `claude` launch found in a command. */
export type Launch = {
  /** The explicit Fable source (`--model claude-fable-5-2`, `ANTHROPIC_MODEL=fable`), null when none is named. */
  fable: string | null
  /** Opens a session: no management subcommand, no `--help` / `--version`. */
  session: boolean
  /** The launch names its own main model (`--model`, `ANTHROPIC_MODEL`), so inherited defaults do not apply. */
  model: boolean
  /** `--agent <name>`: the session runs as that agent, on its model unless `--model` is given. */
  agent: string | null
  /** `--agents` / `--settings` given as a file path: the caller reads it. */
  agentsFile: string | null
  settingsFile: string | null
  /** The launch's own words, for the journal. */
  text: string
}

/** A Fable model in settings JSON text: its `model` or a model env var. */
export function settingsFable(text: string): string | null {
  const m = /"(model|ANTHROPIC_[A-Z0-9_]*MODEL)"\s*:\s*"([^"]*)"/gi
  for (const hit of text.matchAll(m)) if (isFable(hit[2])) return `${hit[1]}: ${hit[2]}`
  return null
}

/** The model of agent `name` in an `--agents` JSON object; undefined when the text is not that JSON or lacks it. */
export function agentsJsonModel(text: string, name: string): string | undefined {
  try {
    const obj = JSON.parse(text) as Record<string, { model?: unknown } | undefined>
    const m = obj?.[name]?.model
    return typeof m === 'string' ? m : undefined
  } catch {
    return undefined
  }
}

/** A model env assignment in a word (`NAME=v`, PowerShell `$env:NAME=v`): its name and value. */
function modelAssignment(word: string): { name: string; value: string } | null {
  const m = /^(?:\$env:)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(word)
  return m && MODEL_ENV.test(m[1]!.toUpperCase()) ? { name: m[1]!.toUpperCase(), value: m[2]! } : null
}

/** The bodies of `$(…)` and backtick substitutions in a word's value (an unclosed one runs to the end). */
function substitutions(value: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < value.length) {
    if (value[i] === '$' && value[i + 1] === '(') {
      let depth = 1
      let j = i + 2
      while (j < value.length && depth > 0) {
        if (value[j] === '(') depth += 1
        else if (value[j] === ')') depth -= 1
        j += 1
      }
      out.push(value.slice(i + 2, depth === 0 ? j - 1 : j))
      i = j
    } else if (value[i] === '`') {
      const close = value.indexOf('`', i + 1)
      out.push(value.slice(i + 1, close < 0 ? value.length : close))
      i = close < 0 ? value.length : close + 1
    } else i += 1
  }
  return out
}

/** The launch at `words[at]` (the `claude` word), with model env set before it in the segment or the command. */
function readLaunch(words: Word[], at: number, env: Map<string, string>, split: boolean): Launch {
  const launch: Launch = { fable: null, session: true, model: false, agent: null, agentsFile: null, settingsFile: null, text: '' }
  const envHere = new Map(env)
  for (const w of words.slice(0, at)) {
    const a = modelAssignment(w.value)
    if (a) envHere.set(a.name, a.value)
  }
  for (const [name, value] of envHere) {
    if (name === 'ANTHROPIC_MODEL') launch.model = true
    if (!launch.fable && isFable(value)) launch.fable = `${name}=${value}`
  }
  const args = words.slice(at + 1).flatMap(w => (split ? w.value.split(/\s+/).filter(Boolean) : [w.value]))
  launch.text = ['claude', ...args].join(' ').slice(0, 300)
  let positional = false
  let agentsText: string | null = null
  const fableFrom = (flag: string, value: string) => {
    if (!launch.fable && isFable(value)) launch.fable = `${flag} ${value}`
  }
  for (let i = 0; i < args.length; i += 1) {
    const raw = args[i]!
    if (raw === '--') break
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1
    const flag = eq > 0 ? raw.slice(0, eq) : raw
    const take = (): string => (eq > 0 ? raw.slice(eq + 1) : (args[++i] ?? ''))
    if (flag === '--model') {
      launch.model = true
      fableFrom(flag, take())
    } else if (flag === '--fallback-model') fableFrom(flag, take())
    else if (flag === '--agent') launch.agent = take()
    else if (flag === '--agents') agentsText = take()
    else if (flag === '--settings') {
      const v = take()
      if (v.trimStart().startsWith('{')) {
        const hit = settingsFable(v)
        if (hit && !launch.fable) launch.fable = `--settings ${hit}`
        if (/"model"\s*:/.test(v)) launch.model = true
      } else launch.settingsFile = v
    } else if (['-h', '--help', '-v', '--version'].includes(flag)) launch.session = false
    else if (VALUE_FLAGS.has(flag)) {
      if (eq < 0) i += 1
    } else if (!flag.startsWith('-') && !positional) {
      positional = true
      if (SUBCOMMANDS.has(flag)) launch.session = false
    }
  }
  if (agentsText !== null) {
    if (agentsText.trimStart().startsWith('{')) {
      const m = launch.agent ? agentsJsonModel(agentsText, launch.agent) : undefined
      if (m !== undefined && !launch.model && isFable(m) && !launch.fable) launch.fable = `--agent ${launch.agent} (model ${m})`
    } else launch.agentsFile = agentsText
  }
  return launch
}

function scan(text: string, depth: number, out: Launch[]): void {
  const env = new Map<string, string>()
  for (const words of segments(text)) {
    // Double-quoted substitutions run whatever the head is: `git commit -m "$(claude -p --model fable …)"`.
    for (const w of words) {
      if (depth < MAX_DEPTH && (w.value.includes('$(') || w.value.includes('`'))) {
        for (const body of substitutions(w.value)) scan(body, depth + 1, out)
      }
    }
    const h = headIndex(words)
    // `export ANTHROPIC_MODEL=…`, `set …`, a bare assignment: model env for the launches after it.
    const head = commandName(words[h]?.value ?? '')
    const bare = h >= words.length || modelAssignment(words[h]!.value) !== null
    const assigns = bare ? words : ['export', 'set', 'setenv', 'declare', 'typeset'].includes(head) ? words.slice(h + 1) : []
    for (const w of assigns) {
      const a = modelAssignment(w.value)
      if (a) env.set(a.name, a.value)
    }
    if (bare || DATA_HEADS.has(head)) continue
    const isClaude = (w: Word) => CLAUDE.has(commandName(w.value))
    // The binary as the command, or handed to a runner (`sudo … claude`, `ssh host claude`, `npx …/claude-code`);
    // `cd ~/claude` is not a launch.
    const at = isClaude(words[h]!) ? h : RUNNERS.has(head) ? words.findIndex((w, i) => i > h && isClaude(w)) : -1
    if (at >= 0) {
      out.push(readLaunch(words, at, env, SPLIT_ARGS.has(head)))
      continue
    }
    if (depth >= MAX_DEPTH || !RUNNERS.has(head)) continue
    for (const w of words.slice(h + 1)) {
      if (/\s/.test(w.value) && /claude/i.test(w.value)) scan(w.value, depth + 1, out)
    }
  }
}

/** Every `claude` launch in a shell command; empty when the command only mentions one. */
export function claudeLaunches(command: string): Launch[] {
  if (!/claude/i.test(command)) return []
  const out: Launch[] = []
  scan(command.length > MAX_SCAN ? command.slice(0, MAX_SCAN) : command, 0, out)
  return out
}

/** The refusal the model gets, with what was found. */
export function fableReason(found: string): string {
  return `Отказано: сессию на Fable запускает только владелец (найдено: ${found.slice(0, 200)}). ` +
    'Сессию запускай на Opus 5.5 high (`--model claude-opus-5-5 --effort high`), а Fable бери субагентом ' +
    '(Agent с `model: "fable"` или `agent()` в Workflow) для тяжёлого финального решения.'
}
