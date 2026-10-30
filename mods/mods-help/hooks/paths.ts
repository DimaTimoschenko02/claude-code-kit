// Path helpers that work on both platforms: the engine hands Windows paths with backslashes and drive letters, macOS
// ones with slashes. Convert with `toSlash` where a path enters the logic, split and compare on `/` after that.

export const toSlash = (p: string): string => p.replace(/\\/g, '/')

/** `/x`, `C:\x`, `C:/x` and `\\server\share` are absolute; `x` and `C:x` are not. */
export const isAbsolute = (p: string): boolean => /^(?:[A-Za-z]:)?[\\/]/.test(p)

export function joinPath(a: string, b: string): string {
  return `${toSlash(a).replace(/\/+$/, '')}/${toSlash(b).replace(/^\/+/, '')}`
}

export function basename(p: string): string {
  const s = toSlash(p).replace(/\/+$/, '')
  return s.slice(s.lastIndexOf('/') + 1)
}

export function dirname(p: string): string {
  const s = toSlash(p).replace(/\/+$/, '')
  const i = s.lastIndexOf('/')
  if (i < 0) return '.'
  const head = s.slice(0, i)
  // `/x` → `/`, `C:/x` → `C:/`: the root keeps its slash.
  return head === '' || /^[A-Za-z]:$/.test(head) ? `${head}/` : head
}

/** CLAUDE_CODE_PLUGIN_DIRS: `;` on Windows (a `:` would cut `C:`), `:` elsewhere. */
export const listSeparator = (isWindows: boolean): string => (isWindows ? ';' : ':')
