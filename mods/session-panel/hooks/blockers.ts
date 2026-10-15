// Blockers: what only the owner can physically do — a disconnected browser extension, a sign-in, a VPN profile, an
// app to start. They sit at the top of the panel until the condition is seen gone, never fold and never age.
import type { Blocker, Panel } from '../types'
import { clip } from './logic'

/** A key the model chooses: `chrome`, `login:<host>`, `vpn`, `app:docker`. */
const KEY = /^[a-z0-9][a-z0-9:._-]{0,63}$/i
const MAX_TEXT = 240
/** Blockers kept per session; past it the oldest goes. */
const MAX_BLOCKERS = 8

export const CHROME = 'chrome'
const CHROME_TOOL = 'mcp__claude-in-chrome__'
const NOT_CONNECTED = /browser extension is not connected/i
/** The extension answered nothing yet said nothing about the link: neither down nor up. */
const UNKNOWN = /did not respond|not respond in time|timed out|offline or asleep/i

export function blockersOf(panel: Panel): Blocker[] {
  return panel.blockers ?? []
}

export function validKey(key: string): boolean {
  return KEY.test(key)
}

/** One line, bounded: the text may carry a page's words, and it reaches the model again in a report. */
export function blockerText(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_TEXT ? `${flat.slice(0, MAX_TEXT - 1)}…` : flat
}

/** Puts a blocker up, or rewrites the one under the same key keeping when it began. Unchanged → the same panel. */
export function raise(panel: Panel, b: Omit<Blocker, 'since'>, now: number): Panel {
  const list = blockersOf(panel)
  const have = list.find(x => x.key === b.key)
  if (have !== undefined && have.text === b.text && have.href === b.href) return panel
  const next: Blocker = { ...b, since: have?.since ?? now }
  if (next.href === undefined) delete next.href
  const rest = list.filter(x => x.key !== b.key)
  return { ...panel, blockers: [...rest, next].slice(-MAX_BLOCKERS) }
}

export function lift(panel: Panel, key: string): Panel {
  const list = blockersOf(panel)
  return list.some(b => b.key === key) ? { ...panel, blockers: list.filter(b => b.key !== key) } : panel
}

/** The owner pressed «сделал» (done) or ✕ (not a blocker): it goes, and the model hears which with the next message. */
export function ownerLift(panel: Panel, key: string, done: boolean): Panel {
  const b = blockersOf(panel).find(x => x.key === key)
  if (b === undefined) return panel
  const what = `«${clip(b.text)}» (${b.key})`
  const line = done
    ? `сделал то, что требовал блокер ${what} — проверь; держится — поставь блокер снова`
    : `убрал блокер ${what}: это не блокер`
  return { ...lift(panel, key), report: [...panel.report, line] }
}

/**
 * What a claude-in-chrome call says about the extension's link: `down` when it is not connected (or no browser is
 * listed), `up` when the call ran, `null` when it cannot tell (a timeout, a refusal, another error).
 */
export function chromeSignal(tool: string, text: string, isError: boolean): 'down' | 'up' | null {
  if (!tool.startsWith(CHROME_TOOL)) return null
  if (NOT_CONNECTED.test(text)) return 'down'
  if (tool === `${CHROME_TOOL}list_connected_browsers` && /^\s*\[\s*\]/.test(text)) return 'down'
  if (isError || UNKNOWN.test(text)) return null
  return 'up'
}

const LOGIN_PATH = /(?:^|\/)(?:login|log-in|signin|sign-in|auth|oauth2?|sso|saml|openid-connect)(?:[/?#.]|$)/i

/** The host a chrome call landed on past its sign-in page (`Navigated to https://host/path`), if it did. */
export function signedInHost(text: string): string | undefined {
  const m = /^Navigated to (https?:\/\/[^\s"]+)/.exec(text)
  if (m === null) return undefined
  try {
    const url = new URL(m[1]!)
    return LOGIN_PATH.test(url.pathname) ? undefined : url.hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** A glyph per kind of blocker, by its key's prefix. */
export function iconOf(key: string): string {
  const kind = key.split(':')[0]!.toLowerCase()
  if (kind === CHROME || kind === 'browser') return '🔌'
  if (kind === 'login' || kind === '2fa' || kind === 'password') return '🔑'
  if (kind === 'vpn' || kind === 'network') return '🌐'
  if (kind === 'app') return '🖥'
  if (kind === 'access' || kind === 'permission') return '🔒'
  return '✋'
}

// The local zone offset as `date +%z` prints it (copied from cache-warm's logic.ts).
export function parseTzOffset(text: string): number | null {
  const m = /([+-])(\d{2})(\d{2})/.exec(text)
  if (m === null) return null
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
}

export function hhmm(ms: number, tzOffsetMin: number): string {
  const d = new Date(ms + tzOffsetMin * 60_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}
