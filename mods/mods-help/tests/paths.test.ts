import { describe, expect, test } from 'claude-code/testing'

import { basename, dirname, isAbsolute, joinPath, listSeparator, toSlash } from '../hooks/paths'

describe('paths', () => {
  test('toSlash turns backslashes into slashes and leaves slash paths alone', () => {
    expect(toSlash('C:\\Users\\dimti\\kit')).toBe('C:/Users/dimti/kit')
    expect(toSlash('/home/x/kit')).toBe('/home/x/kit')
  })

  test('isAbsolute knows POSIX, drive-letter and UNC paths', () => {
    for (const p of ['/x', 'C:\\x', 'C:/x', '\\\\server\\share']) expect(isAbsolute(p)).toBe(true)
    for (const p of ['x', 'a/b', 'C:x', '']) expect(isAbsolute(p)).toBe(false)
  })

  test('joinPath, basename and dirname work on both separators', () => {
    expect(joinPath('C:\\kit\\mods\\', '.claude-plugin/plugin.json')).toBe('C:/kit/mods/.claude-plugin/plugin.json')
    expect(joinPath('/home/x/', '/y')).toBe('/home/x/y')
    expect(basename('C:\\kit\\mods\\dictate\\')).toBe('dictate')
    expect(basename('/home/x/dictate')).toBe('dictate')
    expect(dirname('C:\\kit\\mods\\dictate')).toBe('C:/kit/mods')
    expect(dirname('/home/x/dictate')).toBe('/home/x')
    expect(dirname('/x')).toBe('/')
    expect(dirname('C:\\x')).toBe('C:/')
    expect(dirname('x')).toBe('.')
  })

  test('listSeparator is `;` on Windows and `:` elsewhere', () => {
    expect(listSeparator(true)).toBe(';')
    expect(listSeparator(false)).toBe(':')
  })
})
