import type { Register } from 'claude-code'

import { plainQuotes, quoteBlocks } from './unquote'

const LOOKBACK = 20

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command
      .register({
        name: 'draft',
        description: 'Copy the quoted draft of the last reply as plain text (/draft 2 — the second one)',
        argumentHint: '[N]',
      })
      .catch(() => undefined)

    return next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    if (e.surface !== 'terminal' || e.component !== 'AssistantMessage') return next(e)

    const text = plainQuotes(e.props.text)

    return text === e.props.text ? next(e) : next({ ...e, props: { ...e.props, text } })
  })

  on('command.run', { command: 'draft' }, async ($, e) => {
    const messages = await $.session.messages().catch(() => [])
    const replies = messages.slice(-LOOKBACK).filter(m => m.role === 'assistant')
    let blocks: string[] = []
    for (let i = replies.length - 1; i >= 0 && blocks.length === 0; i -= 1) {
      blocks = quoteBlocks(replies[i]?.text ?? '')
    }
    if (blocks.length === 0) return { text: 'в последних ответах нет цитаты-черновика (`> …`)' }

    const asked = Number.parseInt(e.args.trim(), 10)
    const index = Number.isInteger(asked) ? asked : blocks.length
    const draft = blocks[index - 1]
    if (draft === undefined) return { text: `в ответе ${blocks.length} черновик(а), нет №${e.args.trim()}` }

    const copied = await $.ui.copy({ text: draft }).catch(() => ({ isCopied: false as const, reason: 'refused' as const }))
    const head = draft.split('\n')[0]?.slice(0, 60) ?? ''
    const others = blocks.length > 1 ? ` · всего ${blocks.length}, другой — /draft N` : ''

    return {
      text: copied.isCopied
        ? `скопировал №${index} (${draft.length} симв.): ${head}…${others}`
        : `не скопировал (${copied.reason}) — текст ниже\n\n${draft}`,
    }
  })
}
