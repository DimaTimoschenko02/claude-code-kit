// Paths as the engine hands them: `/x` on macOS, `C:\x` on Windows. Logic normalizes with toSlash where a path
// enters, then splits and compares on `/` only; `$.fs` takes `C:/x` as readily as `C:\x`.

/** One separator for the logic: backslashes become slashes. */
export const toSlash = (p: string): string => p.replace(/\\/g, '/')

/** Absolute on either platform: `/x`, `C:\x`, `C:/x`, `\\server\share`. */
export const isAbsolute = (p: string): boolean => /^(?:[A-Za-z]:)?[\\/]/.test(p)

/** A filesystem root alone: `/`, `C:`, `C:/`. Never a place to link or write under. */
export const isRoot = (p: string): boolean => /^(?:[A-Za-z]:)?[\\/]?$/.test(p)

/** `a` and `b` joined by a single `/`. */
export const joinPath = (a: string, b: string): string => `${toSlash(a).replace(/\/+$/, '')}/${toSlash(b).replace(/^\/+/, '')}`

/** The last segment, on either separator. */
export const basename = (p: string): string => toSlash(p).replace(/\/+$/, '').split('/').pop() ?? ''

/** All but the last segment; a root stays that root (`/`, `C:/`). */
export function dirname(p: string): string {
  const s = toSlash(p).replace(/\/+$/, '')
  const cut = s.lastIndexOf('/')
  if (cut < 0) return '.'
  const head = s.slice(0, cut)
  return head === '' || /^[A-Za-z]:$/.test(head) ? `${head}/` : head
}

/** The separator of a path list such as CLAUDE_CODE_PLUGIN_DIRS: `;` on Windows, `:` elsewhere. */
export const listSeparator = (isWindows: boolean): string => (isWindows ? ';' : ':')
