import type { EngineInterface as Engine } from 'claude-code'

export type Mode = 'default' | 'codex-first' | 'claude-only'
export type Priority = { mode: Mode; until: string | null; offline?: boolean }
type Source = { file: string; url?: string }

function decode(text: string): Priority {
  const { mode, until } = JSON.parse(text)
  if (!['default', 'codex-first', 'claude-only'].includes(mode) ||
      (until !== null && (typeof until !== 'string' || !Number.isFinite(Date.parse(until))))) throw Error('Invalid agent priority')
  return { mode, until }
}

/** Config is local and opt-in. Every dispatch sees the authority, including from a running session. */
export async function readPriority($: Engine, home: string | undefined): Promise<Priority | null> {
  if (!home) return null
  const raw = await $.fs.read(home + '/.claude/state/agent-routes/authority.json').catch(() => undefined)
  if (!raw) return null
  const source: Source = JSON.parse(raw)
  let state: Priority
  if (source.url) {
    try {
      const response = await Promise.race([
        $.http.fetch(source.url),
        $.clock.sleep(1200).then(() => { throw Error('Priority authority timed out') }),
      ])
      if (!response.ok) throw Error('Priority authority unavailable')
      state = decode(response.text)
    } catch {
      // While disconnected we cannot verify that the owner permits spending Codex.
      state = { mode: 'claude-only', until: null, offline: true }
    }
  } else {
    const text = await $.fs.read(source.file).catch(() => undefined)
    state = text ? decode(text) : { mode: 'default', until: null }
  }
  if (state.until && Date.parse(state.until) <= await $.clock.now()) return { mode: 'default', until: null }
  return state
}

export function preferenceText(p: Priority): string {
  const title = 'Общий приоритет агентов: ' + p.mode + (p.until ? ' до ' + p.until : '') + '.'
  const body = p.mode === 'default' ? 'Действуют проектные маршруты.'
    : p.mode === 'claude-only' ? 'Новые поручения выполняют Claude-агенты. Для Sol-маршрутов используй Claude-роль проекта. Это распространяется на Workflow, фоновые запуски и обёртки.'
    : 'Большую самостоятельную часть (чтение → решение → проверка → краткий отчёт) сразу отдай Codex через лаунчер проекта. Роль, требования к спеке и проверки проекта сохраняй. Это касается также роутинга Workflow и фоновых задач. Единичное действие сделай сам. Если нужен Claude-only инструмент или Codex не смог выполнить работу, используй Claude и укажи фактическую причину.'
  return title + ' ' + body + (p.offline ? ' Источник приоритета недоступен. Повторная проверка перед следующим запуском.' : '') +
    ' Переключение по просьбе владельца: skill agent-priority.'
}
