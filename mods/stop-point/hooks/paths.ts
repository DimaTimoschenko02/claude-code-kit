// Paths on both platforms: the engine hands Windows paths with backslashes (`C:\Users\...`), and `$.fs` takes
// forward slashes there too, so a path is turned to slashes where it enters the mod and split on `/` after that.

export const toSlash = (p: string): string => p.replace(/\\/g, '/')

/** `/x`, `C:\x`, `C:/x`, `\\server\share`; not `C:x` (drive-relative) and not `x/y`. */
export const isAbsolute = (p: string): boolean => /^(?:[A-Za-z]:)?[\\/]/.test(p)

export const joinPath = (a: string, b: string): string => `${toSlash(a).replace(/\/+$/, '')}/${toSlash(b).replace(/^\/+/, '')}`

export const basename = (p: string): string => {
  const t = toSlash(p).replace(/\/+$/, '')
  return t.slice(t.lastIndexOf('/') + 1)
}

export const dirname = (p: string): string => {
  const t = toSlash(p).replace(/\/+$/, '')
  const i = t.lastIndexOf('/')
  if (i < 0) return '.'
  // a root keeps its slash: `/x` → `/`, `C:/x` → `C:/`
  return i === 0 || /^[A-Za-z]:$/.test(t.slice(0, i)) ? t.slice(0, i + 1) : t.slice(0, i)
}

/** `.` and `..` resolved, slashes, the drive letter upper-cased (Windows drives ignore case; a prefix check does not). */
export function normalize(p: string): string {
  const t = toSlash(p)
  const drive = /^[A-Za-z]:/.exec(t)?.[0]?.toUpperCase() ?? ''
  const parts: string[] = []
  for (const part of t.slice(drive.length).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${drive}/${parts.join('/')}`
}
