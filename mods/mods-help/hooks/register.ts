// mods-help: /mods lists the slash commands the loaded mods serve, read live from the engine, so a mod that adds a
// command shows up here without touching this one.

import type { CommandInfo, EngineInterface, Register } from 'claude-code'

export const COMMAND = 'mods'

export type Mod = { name: string; description: string }

/** The folders in CLAUDE_CODE_PLUGIN_DIRS, each named by its plugin.json; a folder without a readable one is skipped. */
async function listedMods($: EngineInterface): Promise<Mod[]> {
  const dirs = ((await $.env.get('CLAUDE_CODE_PLUGIN_DIRS')) ?? '').split(':').filter(d => d !== '')
  const mods: Mod[] = []
  for (const dir of dirs) {
    try {
      const m: unknown = JSON.parse(await $.fs.read(`${dir.replace(/\/+$/, '')}/.claude-plugin/plugin.json`))
      if (typeof m !== 'object' || m === null) continue
      const { name, description } = m as { name?: unknown; description?: unknown }
      if (typeof name === 'string') mods.push({ name, description: typeof description === 'string' ? description : '' })
    } catch {
      // not a mod folder, or unreadable: nothing to list for it
    }
  }
  return mods
}

export function format(mods: readonly Mod[], commands: readonly CommandInfo[], self: string): string {
  const names = new Set(mods.map(m => m.name))
  const served = commands
    .filter(c => c.source === 'plugin' && c.plugin !== undefined && names.has(c.plugin) && c.plugin !== self)
    .sort((a, b) => a.name.localeCompare(b.name))
  const withCommands = new Set(served.map(c => c.plugin))
  const silent = mods.filter(m => m.name !== self && !withCommands.has(m.name))
  const lines: string[] = []
  if (served.length === 0) lines.push('Команд у модов в этой сессии нет.')
  else {
    lines.push('Команды модов:')
    for (const c of served) lines.push(`  /${c.name} — ${c.description} (${c.plugin})`)
  }
  if (silent.length > 0) {
    lines.push('', 'Без команд в этой сессии:')
    for (const m of silent) lines.push(`  ${m.name} — ${m.description}`)
  }
  return lines.join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command
      .register({ name: COMMAND, description: 'Команды модов и что они делают', immediate: true })
      .catch(err => $.ui.log(`mods-help: /${COMMAND} not registered: ${String(err)}`, { to: 'debug' }))
    return next(e)
  })

  on('command.run', { command: COMMAND }, async $ => {
    const [mods, commands] = await Promise.all([listedMods($), $.command.list()])
    return { text: format(mods, commands, $.plugin.name) }
  })
}
