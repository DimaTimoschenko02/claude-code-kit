import type { Elements, EngineInterface, Register } from 'claude-code'

import { compileRules, hasMarkers, plan, stripMarkers } from './colorize'
import type { Line, Run, Segment } from './colorize'
import { INSTRUCTION, INSTRUCTION_ID } from './instruction'
import { MARKS } from './rules'
import { SAMPLE } from './sample'

const COMMAND = 'semantic-colors'
// The engine shows a toast, a status line and a command's text under the plugin's name already: no name in them.
const WARNING = 'render hook broken, falling back to stock rendering — /semantic-colors for details'
const STATUS = '🔴 render hook broken, stock rendering — /semantic-colors'
// The command row's text arrives with the plugin's name in front; the sample is planned without it.
const NAME_PREFIX = /^semantic-colors:\s*/
// Lines the engine itself writes as an assistant message and draws in its error colour: never take them over.
const ENGINE_NOTICE =
  /^(?:API Error|Credit balance|Prompt is too long|Request timed out|Invalid API key|We are experiencing|Claude AI usage limit|You've hit your|Your computer went to sleep|\[Request interrupted)/
// Replies drawn on a terminal before the mod calls the AssistantMessage site gone, if none of them came through it.
const SILENT_AFTER = 2
const CACHE_SIZE = 200
// Prompts no person reads on a terminal: the instruction stays out, so the model writes no marks there.
const NO_MARKS_TRAITS = new Set(['print', 'teammate', 'bare'])

type Terminal = Elements['terminal']
type Failure = { readonly at: string; readonly kind: string; readonly reason: string }

// What an earlier load stored: read back as data, a shape from another version taken as nothing.
function isFailure(value: unknown): value is Failure {
  const v = value as Partial<Record<keyof Failure, unknown>> | null
  return typeof v === 'object' && v !== null && typeof v.at === 'string' && typeof v.kind === 'string' && typeof v.reason === 'string'
}

const RULES = compileRules()

// Module variables start over on every load, which is what the self-check wants: one warning per load.
const health = { drawn: 0, colored: 0, repliesSeen: 0, failures: 0, warned: false }
let tripped: Failure | null = null
let lastStored: Failure | null = null
let enabled = true
let glyph = '●'
// `/semantic-colors selftest [throw|refuse]` arms one simulated failure for the next coloured reply.
let simulate: 'throw' | 'refuse' | null = null
const cache = new Map<string, Segment[] | null>()
const strippedCache = new Map<string, string>()

function planned(text: string): Segment[] | null {
  const hit = cache.get(text)
  if (hit !== undefined || cache.has(text)) return hit ?? null
  const result = plan(text, RULES)
  cache.set(text, result)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value ?? '')
  return result
}

// A redraw repeats on every scroll: the stripped text of a reply is worked out once.
function unmarked(text: string): string {
  const hit = strippedCache.get(text)
  if (hit !== undefined) return hit
  const result = stripMarkers(text)
  strippedCache.set(text, result)
  if (strippedCache.size > CACHE_SIZE) strippedCache.delete(strippedCache.keys().next().value ?? '')
  return result
}

// Fail open from here on and tell the owner once per load: a toast now, a status line that stays, the reason kept.
function noteFailure($: EngineInterface, kind: string, reason: string): void {
  const failure: Failure = { at: new Date().toISOString(), kind, reason: reason.slice(0, 300) }
  health.failures += 1
  tripped = tripped ?? failure
  lastStored = failure
  $.store.set('lastFailure', failure).catch(() => undefined)
  if (health.warned) return
  health.warned = true
  try {
    $.ui.toast(WARNING)
  } catch {}
  try {
    $.ui.status(STATUS)
  } catch {}
  $.ui.log(`${WARNING}: ${kind}: ${failure.reason}`, { to: 'debug' })
}

function runProps(run: Run): Record<string, string | boolean> {
  return {
    ...(run.color !== undefined && { color: run.color }),
    ...(run.bold && { bold: true }),
    ...(run.italic && { italic: true }),
    ...(run.strike && { strikethrough: true }),
  }
}

function drawRun(T: Terminal, run: Run) {
  const { Link, Text } = T
  const text = <Text {...runProps(run)}>{run.text}</Text>
  return run.href ? <Link href={run.href}>{text}</Link> : text
}

function drawLine(T: Terminal, line: Line) {
  const { Box, Text } = T
  if (line.runs.length === 0) return <Text> </Text>
  const runs = line.runs.map(run => drawRun(T, run))
  const body = line.accent ? <Text color={line.accent.color} bold={line.accent.bold}>{runs}</Text> : <Text>{runs}</Text>
  if (!line.prefix) return body
  return (
    <Box flexDirection="row">
      <Box flexShrink={0}>
        <Text>{line.prefix}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1}>
        {body}
      </Box>
    </Box>
  )
}

function drawSegments(T: Terminal, segments: readonly Segment[]) {
  const { Box, Markdown } = T
  return (
    <Box flexDirection="column" flexGrow={1} flexShrink={1} gap={1}>
      {segments.map(segment =>
        segment.kind === 'markdown' ? (
          <Markdown text={segment.text} />
        ) : (
          <Box flexDirection="column">{segment.lines.map(line => drawLine(T, line))}</Box>
        ),
      )}
    </Box>
  )
}

function statusText(): string {
  const state = !enabled
    ? 'off (/semantic-colors on) — marks already in the thread are hidden, not coloured'
    : tripped
      ? `BROKEN, stock rendering, marks hidden: ${tripped.kind}: ${tripped.reason}`
      : 'on'
  const counts = `${health.drawn} reply blocks drawn, ${health.colored} coloured since this session loaded the mod`
  const silent =
    enabled && !tripped && health.repliesSeen > 0 && health.drawn === 0
      ? ` · ⚠ ${health.repliesSeen} replies, none drawn through the mod yet`
      : ''
  const rules = RULES.broken.length > 0 ? `\nrules that do not compile (skipped): ${RULES.broken.join('; ')}` : ''
  const last = lastStored ? `\nlast failure: ${lastStored.at} · ${lastStored.kind}: ${lastStored.reason}` : ''
  return [
    `${state} · ${counts}${silent}`,
    `marks the model writes around a whole phrase: ${MARKS.map(m => `${m.open}…${m.close} ${m.name}`).join(' · ')} — taught by a system-prompt section the mod adds`,
    `rules: ${RULES.rules.map(c => c.rule.name).join(', ')} + accent lines, never inside a mark — edit hooks/rules.ts`,
    'on / off: drawing switches at once; the instruction to the model only for new conversations (a running one keeps its prompt)',
    '/semantic-colors sample — marks and rules on a sample · selftest [throw|refuse] — fake a failure · reset · off / on',
  ].join('\n') + rules + last
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    if (/^[A-Za-z]:[\\/]/.test(e.cwd)) glyph = '●'
    else glyph = '⏺'
    const stored = await $.store.get('enabled').catch(() => undefined)
    enabled = stored !== false
    const failure = await $.store.get('lastFailure').catch(() => undefined)
    lastStored = isFailure(failure) ? failure : null
    await $.command
      .register({ name: COMMAND, description: 'Semantic colours in replies: status and self-check; sample · on · off', argumentHint: '[sample|selftest|reset|on|off]' })
      .catch(() => undefined)
    if (RULES.broken.length > 0) $.ui.toast(`${RULES.broken.length} rule(s) do not compile and are skipped — /semantic-colors`)
    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (e.component !== 'AssistantMessage') return next(e)
    const props: unknown = e.props
    const shape = props as { text?: unknown; isFirstOfReply?: unknown } | null
    const text = typeof shape?.text === 'string' ? shape.text : null
    // Wherever the engine draws the reply itself, the marks go first: raw `{+` never reaches a screen. The spread
    // carries `isSummary` and `onScreen` on as received, which a rewrite must; a rewrite that throws draws stock.
    const stock = () => {
      if (text === null || ENGINE_NOTICE.test(text) || !hasMarkers(text)) return next(e)
      try {
        return next({ ...e, props: { ...e.props, text: unmarked(text) } })
      } catch {
        return next(e)
      }
    }
    if (e.surface !== 'terminal' || !enabled || tripped) return stock()
    if (text === null || typeof shape?.isFirstOfReply !== 'boolean') {
      noteFailure($, 'props', `AssistantMessage props changed shape: ${JSON.stringify(Object.keys(shape ?? {}))}`)
      return stock()
    }
    health.drawn += 1
    if (ENGINE_NOTICE.test(text)) return next(e)
    if (e.props.isSummary) return stock()
    try {
      const segments = planned(text)
      if (segments === null) return stock()
      const T = $.ui.resolve(e)
      const { Box, Text } = T
      if (simulate === 'throw') {
        simulate = null
        throw new Error('simulated by /semantic-colors selftest')
      }
      if (simulate === 'refuse') {
        simulate = null
        // Not a tree at all: the site refuses the answer, so the registration's .catch must take over.
        return { refused: true } as never
      }
      health.colored += 1
      return (
        <Box flexDirection="row" alignItems="flex-start" marginTop={1} width="100%">
          {e.props.isFirstOfReply && (
            <Box minWidth={2} flexShrink={0}>
              <Text color="text">{glyph}</Text>
            </Box>
          )}
          {drawSegments(T, segments)}
        </Box>
      )
    } catch (error) {
      noteFailure($, 'threw', error instanceof Error ? error.message : String(error))
      return stock()
    }
    // The last resort stays the engine's own drawing as it is: a fallback here must not be able to fail again.
  }).catch(($, e, next) => {
    noteFailure($, next.error.kind === 'timeout' ? 'timeout' : 'refused', next.error.message ?? 'no reason given')
    return next(e)
  })

  // The sample drawn in the command's own row, through the same planner: no model call.
  on('ui.render', { component: 'CommandOutput', props: { command: 'semantic-colors' } }, ($, e, next) => {
    if (e.component !== 'CommandOutput' || e.props.isErrored || e.props.args.trim() !== 'sample') return next(e)
    // The sample is all marks: a surface the mod does not draw on shows it with them taken out.
    const stock = () => {
      try {
        return next({ ...e, props: { ...e.props, text: unmarked(e.props.text) } })
      } catch {
        return next(e)
      }
    }
    if (e.surface !== 'terminal') return stock()
    try {
      const segments = planned(e.props.text.replace(NAME_PREFIX, ''))
      if (segments === null) return stock()
      const T = $.ui.resolve(e)
      const { Box, Text } = T
      // The stock row's gutter, so the sample sits under its echo like any command output.
      return (
        <Box flexDirection="row" width="100%">
          <Box minWidth={5} flexShrink={0}>
            <Text dimColor>{'  ⎿  '}</Text>
          </Box>
          {drawSegments(T, segments)}
        </Box>
      )
    } catch (error) {
      noteFailure($, 'threw', `sample: ${error instanceof Error ? error.message : String(error)}`)
      return stock()
    }
  }).catch(($, e, next) => {
    noteFailure($, 'refused', `sample: ${next.error.message ?? 'no reason given'}`)
    return next(e)
  })

  // The marks are taught here and only here: no mod loaded, no instruction, no stray marks. A prompt is composed
  // per conversation, so a running thread keeps the one it started with whatever on/off says now.
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!enabled || !e.surfaces.includes('terminal') || e.traits.some(trait => NO_MARKS_TRAITS.has(trait))) return result
    if (result.sections.some(section => section.id === INSTRUCTION_ID)) return result
    return { sections: [...result.sections, { id: INSTRUCTION_ID, scope: 'session', text: INSTRUCTION }] }
  })

  // The site can go quiet without an error (renamed by an update): replies on a terminal that never reach the hook.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!enabled || tripped || e.agentId || e.reason !== 'answer' || !e.answer.trim()) return result
    const surfaces = await $.session.surfaces().catch(() => [] as readonly string[])
    if (!surfaces.includes('terminal')) return result
    health.repliesSeen += 1
    if (health.repliesSeen >= SILENT_AFTER && health.drawn === 0) {
      noteFailure($, 'silent', `${health.repliesSeen} replies finished on the terminal and none reached the AssistantMessage hook`)
    }
    return result
  })

  on('command.run', { command: 'semantic-colors' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'sample') return { text: SAMPLE }
    if (arg === 'selftest' || arg === 'selftest throw' || arg === 'selftest refuse') {
      simulate = arg.endsWith('refuse') ? 'refuse' : 'throw'
      tripped = null
      health.warned = false
      return {
        text: `the next coloured reply will ${simulate === 'throw' ? 'throw' : 'return a tree the engine refuses'} on purpose — expect the stock drawing, a toast and a red status; /semantic-colors reset brings the colours back`,
      }
    }
    if (arg === 'reset') {
      tripped = null
      health.warned = false
      simulate = null
      try {
        $.ui.status(undefined)
      } catch {}
      return { text: `reset — colours back for new replies
${statusText()}` }
    }
    if (arg === 'on' || arg === 'off') {
      enabled = arg === 'on'
      await $.store.set('enabled', enabled).catch(() => undefined)
      return {
        text: enabled
          ? 'on — marks are drawn as colour now; the model is taught them in conversations started from here on. Kept across sessions'
          : 'off — replies draw stock now, marks already in the thread hidden; new conversations no longer teach the model the marks. Kept across sessions',
      }
    }
    return { text: statusText() }
  })
}
