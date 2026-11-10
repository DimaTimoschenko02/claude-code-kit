import type { Elements, EngineInterface, Register } from 'claude-code'

import { compileRules, plan } from './colorize'
import type { Line, Run, Segment } from './colorize'
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

function planned(text: string): Segment[] | null {
  const hit = cache.get(text)
  if (hit !== undefined || cache.has(text)) return hit ?? null
  const result = plan(text, RULES)
  cache.set(text, result)
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value ?? '')
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
  const state = !enabled ? 'off (/semantic-colors on)' : tripped ? `BROKEN, stock rendering: ${tripped.kind}: ${tripped.reason}` : 'on'
  const counts = `${health.drawn} reply blocks drawn, ${health.colored} coloured since this session loaded the mod`
  const silent =
    enabled && !tripped && health.repliesSeen > 0 && health.drawn === 0
      ? ` · ⚠ ${health.repliesSeen} replies, none drawn through the mod yet`
      : ''
  const rules = RULES.broken.length > 0 ? `\nrules that do not compile (skipped): ${RULES.broken.join('; ')}` : ''
  const last = lastStored ? `\nlast failure: ${lastStored.at} · ${lastStored.kind}: ${lastStored.reason}` : ''
  return [
    `${state} · ${counts}${silent}`,
    `rules: ${RULES.rules.map(c => c.rule.name).join(', ')} + accent lines — edit hooks/rules.ts`,
    '/semantic-colors sample — every rule on a sample · selftest [throw|refuse] — fake a failure · reset · off / on',
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
    if (e.component !== 'AssistantMessage' || e.surface !== 'terminal' || !enabled || tripped) return next(e)
    const props: unknown = e.props
    const shape = props as { text?: unknown; isFirstOfReply?: unknown } | null
    if (typeof shape?.text !== 'string' || typeof shape.isFirstOfReply !== 'boolean') {
      noteFailure($, 'props', `AssistantMessage props changed shape: ${JSON.stringify(Object.keys(shape ?? {}))}`)
      return next(e)
    }
    health.drawn += 1
    if (e.props.isSummary || ENGINE_NOTICE.test(e.props.text)) return next(e)
    try {
      const segments = planned(e.props.text)
      if (segments === null) return next(e)
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
      return next(e)
    }
  }).catch(($, e, next) => {
    noteFailure($, next.error.kind === 'timeout' ? 'timeout' : 'refused', next.error.message ?? 'no reason given')
    return next(e)
  })

  // The sample drawn in the command's own row, through the same planner: no model call.
  on('ui.render', { component: 'CommandOutput', props: { command: 'semantic-colors' } }, ($, e, next) => {
    if (e.component !== 'CommandOutput' || e.surface !== 'terminal' || e.props.isErrored || e.props.args.trim() !== 'sample') return next(e)
    try {
      const segments = planned(e.props.text.replace(NAME_PREFIX, ''))
      if (segments === null) return next(e)
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
      return next(e)
    }
  }).catch(($, e, next) => {
    noteFailure($, 'refused', `sample: ${next.error.message ?? 'no reason given'}`)
    return next(e)
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
      return { text: `${arg} — new replies draw ${enabled ? 'coloured' : 'stock'}; the setting is kept across sessions` }
    }
    return { text: statusText() }
  })
}
