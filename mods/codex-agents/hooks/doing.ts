// What a Codex run is doing, in words: a shell command or tool call becomes a short phrase («reading SKILL.md»,
// «running a Python script», «viewing A07/grid_01.jpg»), an agent's commentary becomes its first sentence. The owner
// read the raw command lines of the first pane as «just code output» and could not tell what the agent was on.

/** One entry of Codex's own `parsed_cmd` on a CommandExecution item. */
export type ParsedCmd = { type?: string; cmd?: string; name?: string; path?: string; query?: string }

const MAX = 70

/** Commands that set the stage and say nothing about the work (used only when nothing else is there). */
const NOISE = new Set(['cd', 'mkdir', 'export', 'set', 'echo', 'printf', 'true', 'false', 'sleep', 'source', '.', 'unset', 'pushd', 'popd', 'trap', 'exit', 'wait', 'date', 'pwd', 'which', 'command', 'type', 'test', '[', 'clear', 'local'])
const READ = new Set(['cat', 'sed', 'nl', 'head', 'tail', 'less', 'more', 'bat', 'wc', 'jq', 'xxd', 'od', 'strings', 'file', 'stat', 'md5', 'shasum', 'diff'])
const SEARCH = new Set(['rg', 'grep', 'egrep', 'ag', 'ack', 'git-grep'])
const LIST = new Set(['ls', 'find', 'tree', 'fd', 'du', 'exa', 'eza'])
const LANG: Record<string, string> = { python: 'Python', python3: 'Python', node: 'Node', tsx: 'TS', 'ts-node': 'TS', bun: 'Bun', deno: 'Deno', ruby: 'Ruby', perl: 'Perl', bash: 'shell', sh: 'shell', zsh: 'shell', osascript: 'AppleScript', swift: 'Swift' }
const PREFIX = new Set(['sudo', 'env', 'nohup', 'time', 'command', 'exec', 'nice', 'caffeinate', 'xargs'])

function cap(s: string, max = MAX): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The last one or two segments of a path or file URL: `p2/shots/A07/grid_01.jpg` → `A07/grid_01.jpg`. */
export function shortPath(p: string, segments = 1): string {
  const clean = p.replace(/^file:\/\//, '').replace(/[/'"]+$/, '')
  const parts = clean.split('/').filter(Boolean)
  return parts.slice(-segments).join('/') || clean
}

/** Shell words of one simple command, quotes taken off (no expansion). */
function words(seg: string): string[] {
  const out: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g
  for (const m of seg.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/** The command lines with heredoc bodies left out; each heredoc's language is kept on its opening line's command. */
function stripHeredocs(text: string): string[] {
  const lines = text.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    out.push(l)
    const m = /<<-?\s*['"]?([A-Za-z_][\w-]*)['"]?/.exec(l)
    if (m === null) continue
    const tag = m[1]!
    while (i + 1 < lines.length && lines[i + 1]!.trim() !== tag) i++
    i++
  }
  return out
}

/** Splits command lines into pipelines at `&&`, `||`, `;` and newlines, keeping each pipeline's first command (quotes respected roughly). */
function segments(lines: string[]): string[] {
  const out: string[] = []
  for (const line of lines) {
    let cur = ''
    let quote: string | null = null
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      if (quote !== null) {
        if (c === quote) quote = null
        else if (c === '\\' && quote === '"') cur += line[i++] ?? ''
        cur += c
        continue
      }
      if (c === '"' || c === "'") {
        quote = c
        cur += c
        continue
      }
      // A pipe's later stages (`| head`, `| sed -n`) shape the output of its first: they are part of that command.
      if (c === '|' && line[i + 1] !== '|') {
        while (i + 1 < line.length && !/[;&]/.test(line[i + 1]!) && !(line[i + 1] === '|' && line[i + 2] === '|')) i++
        continue
      }
      if (c === ';' || c === '|' || (c === '&' && line[i + 1] === '&')) {
        if (cur.trim() !== '') out.push(cur.trim())
        cur = ''
        if (line[i + 1] === c) i++
        continue
      }
      cur += c
    }
    if (cur.trim() !== '') out.push(cur.trim())
  }
  return out.map(s => s.replace(/^[({\s]+|[)}\s]+$/g, '')).filter(s => s !== '' && !s.startsWith('#'))
}

/** The program and its arguments, leading env assignments and wrappers (`sudo`, `env`, `timeout 30`) taken off. */
function programOf(seg: string): { prog: string; args: string[] } | null {
  const w = words(seg)
  while (w.length > 0) {
    const first = w[0]!
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first) || PREFIX.has(first)) w.shift()
    else if (first === 'timeout' || first === 'gtimeout') w.splice(0, 2)
    else break
  }
  if (w.length === 0) return null
  return { prog: shortPath(w[0]!), args: w.slice(1) }
}

const plain = (args: string[]) => args.filter(a => !a.startsWith('-'))
/** The last argument that looks like a file (has a dot or a slash), else the last plain one. */
function target(args: string[]): string | undefined {
  const p = plain(args)
  const file = [...p].reverse().find(a => /[./]/.test(a) && !/^\d+(,\d+)?[pd]?$/.test(a) && !a.includes('$('))
  return file ?? p[p.length - 1]
}

function phrase(prog: string, args: string[], heredoc: boolean): string {
  if (READ.has(prog)) {
    if (prog === 'sed' && args.some(a => a === '-i' || a.startsWith('-i'))) return `editing ${shortPath(target(args) ?? 'a file')}`
    const t = target(args)
    return t === undefined ? `${prog} (reading input)` : `reading ${shortPath(t)}`
  }
  if (SEARCH.has(prog)) {
    if (args.includes('--files')) return 'listing files'
    const q = plain(args)[0]
    return q === undefined ? 'searching' : `searching "${cap(q, 30)}"`
  }
  if (LIST.has(prog)) {
    const t = plain(args)[0]
    return `listing ${t === undefined ? 'files' : shortPath(t)}`
  }
  const lang = LANG[prog] ?? (/^python3?\.\d+$/.test(prog) ? 'Python' : undefined)
  if (lang !== undefined) {
    if (heredoc || args[0] === '-' || args.length === 0) return `running a ${lang} script`
    if (args.includes('-c') || args.includes('-e')) return `running a ${lang} one-liner`
    const file = plain(args).find(a => /\.\w+$/.test(a))
    return file === undefined ? `running ${prog}` : `running ${shortPath(file)}`
  }
  if (prog === 'ffmpeg') {
    const i = args.indexOf('-i')
    const input = i >= 0 && args[i + 1] !== undefined ? shortPath(args[i + 1]!) : 'a video'
    const frames = args.some(a => a.startsWith('-frames') || /\b(fps|tile|select)=/.test(a)) || args.some(a => /\.(png|jpe?g)$/i.test(a))
    return frames ? `cutting frames from ${input}` : `ffmpeg on ${input}`
  }
  if (prog === 'ffprobe') return `probing ${shortPath(target(args) ?? 'a video')}`
  if (prog === 'magick' || prog === 'convert' || prog === 'montage') return 'building an image'
  if (prog === 'git') {
    const sub = plain(args)[0]
    return sub === undefined ? 'git' : `git ${sub}`
  }
  if (prog === 'npm' || prog === 'pnpm' || prog === 'yarn' || prog === 'bun') {
    return cap(`${prog} ${plain(args).slice(0, 2).join(' ')}`.trim(), 40)
  }
  if (prog === 'npx' || prog === 'bunx') return cap(`npx ${plain(args).slice(0, 2).join(' ')}`.trim(), 40)
  if (prog === 'vitest' || prog === 'jest' || prog === 'pytest') return 'running tests'
  if (prog === 'tsc') return 'type-checking'
  if (prog === 'apply_patch' || prog === 'patch') return 'editing files'
  if (prog === 'curl' || prog === 'wget' || prog === 'http') {
    const url = plain(args).find(a => /^https?:\/\//.test(a))
    const host = url === undefined ? undefined : /^https?:\/\/([^/:?#]+)/.exec(url)?.[1]
    return host === undefined ? 'fetching a URL' : `fetching ${host}`
  }
  if (prog === 'rm') return `removing ${shortPath(target(args) ?? 'files')}`
  if (prog === 'mv' || prog === 'cp') return `${prog === 'mv' ? 'moving' : 'copying'} ${shortPath(target(args) ?? 'files')}`
  if (prog === 'ps' || prog === 'pgrep' || prog === 'lsof') return 'checking processes'
  if (prog === 'docker' || prog === 'kubectl' || prog === 'gh' || prog === 'psql' || prog === 'make' || prog === 'cargo' || prog === 'go') {
    return cap(`${prog} ${plain(args).slice(0, 2).join(' ')}`.trim(), 40)
  }
  const t = target(args)
  return cap(t === undefined ? prog : `${prog} ${shortPath(t)}`, 40)
}

/** A shell command as a short phrase: its first command that does the work, `+N` for the others that do. */
export function describeCommand(cmd: string, parsed?: readonly ParsedCmd[]): string | undefined {
  const known = (parsed ?? []).filter(p => p.type === 'read' || p.type === 'list_files' || p.type === 'search')
  if (parsed !== undefined && parsed.length > 0 && known.length === parsed.length) {
    const p = known[0]!
    const more = known.length > 1 ? ` +${known.length - 1}` : ''
    if (p.type === 'read') return cap(`reading ${shortPath(p.name ?? p.path ?? 'a file')}${more}`)
    if (p.type === 'list_files') return cap(`listing ${shortPath(p.path ?? 'files')}${more}`)
    return cap(`searching "${cap(p.query ?? '', 30)}"${more}`)
  }
  const lines = stripHeredocs(cmd.slice(0, 20_000))
  const segs: { seg: string; heredoc: boolean }[] = []
  for (const line of lines) for (const seg of segments([line])) segs.push({ seg, heredoc: /<<-?\s*['"]?[A-Za-z_]/.test(seg) })
  const progs = segs.map(s => ({ ...s, p: programOf(s.seg.replace(/<<-?\s*['"]?[\w-]+['"]?/, '')) })).filter(s => s.p !== null)
  const work = progs.filter(s => !NOISE.has(s.p!.prog))
  const chosen = work[0] ?? progs[0]
  if (chosen === undefined || chosen.p === null) return undefined
  const more = work.length > 1 ? ` +${work.length - 1}` : ''
  return cap(`${phrase(chosen.p.prog, chosen.p.args, chosen.heredoc)}${more}`)
}

/** An agent message's first sentence (its first line, list marks and bold taken off). */
export function noteLine(text: string | undefined): string | undefined {
  const first = (text ?? '').split('\n').map(l => l.trim()).find(l => l !== '')
  if (first === undefined) return undefined
  const line = first.replace(/^(?:[-*•]|\d+[.)])\s+/, '').replace(/\*\*/g, '').replace(/`/g, '').trim()
  const end = /[.!?…](?=\s|$)/g
  for (const m of line.matchAll(end)) {
    if (m.index >= 15) return cap(line.slice(0, m.index + 1), 120)
  }
  return cap(line, 120)
}

/** A code-mode `exec` call's JS as a phrase: its shell command, else the tool it calls. */
export function describeJs(input: string, cmd: string | undefined): string | undefined {
  if (cmd !== undefined) return describeCommand(cmd)
  const view = /tools\.view_image\(\s*\{[^}]*?path\s*:\s*["'`]([^"'`]+)["'`]/.exec(input)
  if (view !== null) return `viewing ${shortPath(view[1]!, 2)}`
  if (/tools\.view_image\(/.test(input)) return 'viewing images'
  if (/tools\.write_stdin\(/.test(input)) return 'waiting on a running command'
  if (/tools\.apply_patch\(/.test(input)) return 'editing files'
  const tool = /tools\.([A-Za-z_][\w]*)\(/.exec(input)?.[1]
  return tool === undefined ? undefined : `tool ${tool}`
}
