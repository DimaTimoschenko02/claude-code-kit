import { toSlash } from '../hooks/paths'

/** A path as the fixtures spell it: on Windows the engine hands an fs hook `/home/x` as `C:\home\x`. */
export const fixturePath = (p: string): string => toSlash(p).replace(/^[A-Za-z]:(?=\/)/, '')
