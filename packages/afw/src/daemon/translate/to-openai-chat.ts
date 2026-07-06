// Neutral IR → OpenAI Chat Completions. Role flattening runs the other way:
// `tool_result` blocks on a user turn become standalone `role:'tool'` messages,
// and an assistant turn's `tool_use` blocks become `tool_calls`.
//
// Lossy: `thinking` blocks are dropped (Chat has no equivalent); an image
// inside a `tool_result` degrades to an `[image]` text marker.

import { nanoid } from 'nanoid'
import {
  type IRBlock,
  type IRRequest,
  type IRResponse,
  imageSourceToUrl,
  openaiStopReason,
} from './ir.ts'
import { effectiveToolDescription, effectiveToolSchema, stringifyToolArgs } from './shared.ts'

export function requestFromIR(ir: IRRequest): unknown {
  const messages: unknown[] = []
  if (ir.system) messages.push({ role: 'system', content: ir.system })
  for (const m of ir.messages) {
    if (m.role === 'user') {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          messages.push({
            role: 'tool',
            tool_call_id: b.toolUseId,
            content: blocksToText(b.content),
          })
        }
      }
      const parts = m.content.filter((b) => b.type === 'text' || b.type === 'image')
      if (parts.length > 0) messages.push({ role: 'user', content: userContent(parts) })
    } else {
      const text = m.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as { text: string }).text)
        .join('')
      const toolUses = m.content.filter((b) => b.type === 'tool_use')
      const msg: Record<string, unknown> = {
        role: 'assistant',
        content: text.length > 0 ? text : null,
      }
      if (toolUses.length > 0) {
        msg.tool_calls = toolUses.map((b) => {
          const t = b as Extract<IRBlock, { type: 'tool_use' }>
          return {
            id: t.id || `call_${nanoid()}`,
            type: 'function',
            function: { name: t.name, arguments: stringifyToolArgs(t.input) },
          }
        })
      }
      messages.push(msg)
    }
  }
  const out: Record<string, unknown> = { model: ir.model, messages, stream: ir.stream }
  if (ir.maxTokens != null) out.max_tokens = ir.maxTokens
  if (ir.temperature != null) out.temperature = ir.temperature
  if (ir.tools && ir.tools.length > 0) {
    out.tools = ir.tools.map((t) => {
      const description = effectiveToolDescription(t)
      return {
        type: 'function',
        function: {
          name: t.name,
          ...(description ? { description } : {}),
          parameters: effectiveToolSchema(t),
        },
      }
    })
  }
  // tool_choice round-trip. Anthropic → OpenAI mapping:
  //   auto       → "auto"
  //   any        → "required"
  //   none       → "none"
  //   {tool,X}   → {type:"function", function:{name:X}}
  // Without this, a forced tool call (e.g. Claude Code's WebSearchTool
  // inner request that pins tool_choice to web_search) gets silently
  // demoted to "optional" on a cross-protocol route and the routed
  // model can ignore the tool entirely.
  if (ir.toolChoice) {
    switch (ir.toolChoice.kind) {
      case 'auto':
        out.tool_choice = 'auto'
        break
      case 'any':
        out.tool_choice = 'required'
        break
      case 'none':
        out.tool_choice = 'none'
        break
      case 'tool':
        out.tool_choice = { type: 'function', function: { name: ir.toolChoice.name } }
        break
    }
  }
  return out
}

export function responseFromIR(ir: IRResponse): unknown {
  let content: string | null = null
  const toolCalls: unknown[] = []
  for (const b of ir.blocks) {
    if (b.type === 'text') content = (content ?? '') + b.text
    else if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id || `call_${nanoid()}`,
        type: 'function',
        function: { name: b.name, arguments: stringifyToolArgs(b.input) },
      })
    }
    // thinking / image / tool_result / unknown → dropped (Chat has no slot)
  }
  const message: Record<string, unknown> = { role: 'assistant', content }
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  const usage: Record<string, unknown> = {
    prompt_tokens: ir.usage.in,
    completion_tokens: ir.usage.out,
    total_tokens: ir.usage.in + ir.usage.out,
  }
  if (ir.usage.cacheRead != null) {
    usage.prompt_tokens_details = { cached_tokens: ir.usage.cacheRead }
  }
  return {
    id: `chatcmpl-${nanoid()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: ir.model,
    choices: [
      { index: 0, message, finish_reason: openaiStopReason(ir.stopReason), logprobs: null },
    ],
    usage,
  }
}

// ── helpers ───────────────────────────────────────────────────────

function userContent(parts: IRBlock[]): unknown {
  if (parts.every((b) => b.type === 'text')) {
    return parts.map((b) => (b as { text: string }).text).join('')
  }
  return parts.map((b) => {
    if (b.type === 'image') {
      return { type: 'image_url', image_url: { url: imageSourceToUrl(b.source) } }
    }
    return { type: 'text', text: (b as { text: string }).text }
  })
}

function blocksToText(blocks: IRBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === 'text') return b.text
      if (b.type === 'image') return '[image]'
      return ''
    })
    .join('')
}
