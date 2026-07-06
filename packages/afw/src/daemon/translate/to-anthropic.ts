// Neutral IR → Anthropic Messages. The IR is Anthropic-shaped, so request
// serialization is near-direct; the one rule is that `max_tokens` is required.

import { nanoid } from 'nanoid'
import type { NormalizedBlock } from '../../core/packet.ts'
import {
  DEFAULT_MAX_TOKENS,
  type IRBlock,
  type IRImageSource,
  type IRRequest,
  type IRResponse,
} from './ir.ts'
import { effectiveToolDescription, effectiveToolSchema } from './shared.ts'

export function requestFromIR(ir: IRRequest): unknown {
  const out: Record<string, unknown> = {
    model: ir.model,
    max_tokens: ir.maxTokens ?? DEFAULT_MAX_TOKENS,
    stream: ir.stream,
    messages: ir.messages.map((m) => ({
      role: m.role,
      content: m.content.map(blockToWire),
    })),
  }
  if (ir.system) out.system = ir.system
  if (ir.temperature != null) out.temperature = ir.temperature
  if (ir.tools && ir.tools.length > 0) {
    out.tools = ir.tools.map((t) => {
      const description = effectiveToolDescription(t)
      return {
        name: t.name,
        ...(description ? { description } : {}),
        input_schema: effectiveToolSchema(t),
      }
    })
  }
  return out
}

export function responseFromIR(ir: IRResponse): unknown {
  const usage: Record<string, number> = {
    input_tokens: ir.usage.in,
    output_tokens: ir.usage.out,
  }
  if (ir.usage.cacheRead != null) usage.cache_read_input_tokens = ir.usage.cacheRead
  if (ir.usage.cacheWrite != null) usage.cache_creation_input_tokens = ir.usage.cacheWrite
  return {
    id: `msg_${nanoid()}`,
    type: 'message',
    role: 'assistant',
    model: ir.model,
    content: ir.blocks.map(responseBlockToWire).filter((b) => b != null),
    stop_reason: ir.stopReason ?? 'end_turn',
    stop_sequence: null,
    usage,
  }
}

// ── helpers ───────────────────────────────────────────────────────

function blockToWire(b: IRBlock): unknown {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text }
    case 'image':
      return { type: 'image', source: imageSourceToWire(b.source) }
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: b.toolUseId,
        content: b.content.map(blockToWire),
        ...(b.isError ? { is_error: true } : {}),
      }
    case 'thinking':
      return { type: 'thinking', thinking: b.text }
  }
}

function responseBlockToWire(b: NormalizedBlock): unknown {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text }
    case 'tool_use':
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} }
    case 'thinking':
      return { type: 'thinking', thinking: b.text }
    case 'image':
      return { type: 'image', source: b.source }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: b.toolUseId,
        content: b.content,
        ...(b.isError ? { is_error: true } : {}),
      }
    case 'unknown':
      return null
  }
}

function imageSourceToWire(src: IRImageSource): unknown {
  if (src.kind === 'base64') {
    return { type: 'base64', media_type: src.mediaType, data: src.data }
  }
  return { type: 'url', url: src.url }
}
