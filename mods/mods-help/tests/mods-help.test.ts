import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { CommandInfo, CommandSpec, On } from 'claude-code'

const KIT = '/home/fake/kit/mods'
const DIRS = [`${KIT}/dictate`, `${KIT}/stop-point/`, `${KIT}/mods-help`, '/home/fake/not-a-mod'].join(':')
const MANIFESTS: Record<string, string> = {
  [`${KIT}/dictate/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'dictate', description: 'Voice batch' }),
  [`${KIT}/stop-point/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'stop-point', description: 'Stop point gate' }),
  [`${KIT}/mods-help/.claude-plugin/plugin.json`]: JSON.stringify({ name: 'mods-help', description: 'this one' }),
}
const COMMANDS: CommandInfo[] = [
  { name: 'compact', description: 'built-in', source: 'builtin' },
  { name: 'pack', description: 'Пачка диктовки', source: 'plugin', plugin: 'dictate' },
  { name: 'mods', description: 'Команды модов', source: 'plugin', plugin: 'mods-help' },
  { name: 'brainstorm', description: 'a marketplace skill', source: 'plugin', plugin: 'superpowers' },
]

function world(on: On) {
  const registered: CommandSpec[] = []
  mock.env(on, { CLAUDE_CODE_PLUGIN_DIRS: DIRS })
  on('fs.read', ($, e) => {
    const text = MANIFESTS[e.path]
    return text === undefined ? { deny: `ENOENT: ${e.path}` } : { value: text }
  })
  on('command.list', () => ({ value: COMMANDS }))
  on('command.register', ($, e) => {
    registered.push(e)
    return { value: { command: e.name } }
  })
  on('ui.log', () => ({ value: undefined }))
  return { registered }
}

const run = ($: Engine) =>
  $.command.run({ command: 'mods', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })

describe('/mods', () => {
  test('lists only the loaded mods\' commands, and the mods that work without one', async ($, on) => {
    world(on)
    const { text } = await run($)
    expect(text).toContain('/pack — Пачка диктовки (dictate)')
    expect(text).toContain('stop-point — Stop point gate')
    expect(text).not.toContain('compact')
    expect(text).not.toContain('brainstorm')
    expect(text).not.toContain('/mods')
    expect(text).not.toContain('not-a-mod')
  })

  test('registers /mods as immediate at session start', async ($, on) => {
    const w = world(on)
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    expect(w.registered).toContainEqual(expect.objectContaining({ name: 'mods', immediate: true }))
  })
})
