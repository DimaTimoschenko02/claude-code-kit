// Path helpers that work on both platforms: the engine hands Windows paths with backslashes and drive letters, macOS
// ones with slashes. Convert with `toSlash` where a path enters the logic, split and compare on `/` after that.

export const toSlash = (p: string): string => p.replace(/\\/g, '/')

export function joinPath(a: string, b: string): string {
  return `${toSlash(a).replace(/\/+$/, '')}/${toSlash(b).replace(/^\/+/, '')}`
}
