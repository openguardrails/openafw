// Neutral IR → OpenAI Responses. The `messages` turns are unrolled into a flat
// `input` item stream; `system` becomes `instructions`.
//
// Lossy: `thinking` blocks are dropped (reasoning items can't be reconstructed
// without the original encrypted payload); an image inside a `tool_result`
// degrades to an `[image]` text marker.

import { nanoid } from 'nanoid'
import { type IRBlock, type IRRequest, type IRResponse, imageSourceToUrl } from './ir.ts'
import {
  LOCAL_SHELL_TOOL,
  effectiveToolDescription,
  effectiveToolSchema,
  freeformInputText,
  inputToShellAction,
  stringifyToolArgs,
} from './shared.ts'

export function requestFromIR(ir: IRRequest): unknown {
  const input: unknown[] = []
  for (const m of ir.messages) {
    if (m.role === 'user') {
      for (const b of m.content) {
        if (b.type === 'tool_result') {
          input.push({
            type: 'function_call_output',
            call_id: b.toolUseId,
            output: blocksToText(b.content),
          })
        }
      }
      const parts = m.content.filter((b) => b.type === 'text' || b.type === 'image')
      if (parts.length > 0) {
        input.push({ type: 'message', role: 'user', content: parts.map(userPart) })
      }
    } else {
      const textParts = m.content.filter((b) => b.type === 'text')
      if (textParts.length > 0) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: textParts.map((b) => ({
            type: 'output_text',
            text: (b as { text: string }).text,
          })),
        })
      }
      for (const b of m.content) {
        if (b.type === 'tool_use') {
          input.push({
            type: 'function_call',
            call_id: b.id,
            name: b.name,
            arguments: stringifyToolArgs(b.input),
          })
        }
      }
    }
  }
  const out: Record<string, unknown> = { model: ir.model, input, stream: ir.stream }
  if (ir.system) out.instructions = ir.system
  if (ir.maxTokens != null) out.max_output_tokens = ir.maxTokens
  if (ir.temperature != null) out.temperature = ir.temperature
  if (ir.tools && ir.tools.length > 0) {
    out.tools = ir.tools.map((t) => {
      const description = effectiveToolDescription(t)
      return {
        type: 'function',
        name: t.name,
        ...(description ? { description } : {}),
        parameters: effectiveToolSchema(t),
      }
    })
  }
  return out
}

export function responseFromIR(ir: IRResponse): unknown {
  const output: unknown[] = []
  for (const b of ir.blocks) {
    if (b.type === 'text') {
      output.push({
        type: 'message',
        id: `msg_${nanoid()}`,
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: b.text, annotations: [] }],
      })
    } else if (b.type === 'tool_use' && b.name === LOCAL_SHELL_TOOL) {
      // The chat backend called the synthetic shell function — hand it back as
      // the `local_shell_call` codex registered, not a `function_call` it has
      // no tool for.
      output.push({
        type: 'local_shell_call',
        id: `lsh_${nanoid()}`,
        call_id: b.id || `call_${nanoid()}`,
        status: 'completed',
        action: inputToShellAction(b.input),
      })
    } else if (b.type === 'tool_use' && b.freeform) {
      // The client registered this as a freeform `custom` tool — hand the
      // call back as a `custom_tool_call` whose `input` is the raw payload,
      // not a JSON-argument `function_call` it has no tool for.
      output.push({
        type: 'custom_tool_call',
        id: `ctc_${nanoid()}`,
        call_id: b.id || `call_${nanoid()}`,
        name: b.name,
        input: freeformInputText(b.input),
        status: 'completed',
      })
    } else if (b.type === 'tool_use') {
      output.push({
        type: 'function_call',
        id: `fc_${nanoid()}`,
        call_id: b.id || `call_${nanoid()}`,
        name: b.name,
        arguments: stringifyToolArgs(b.input),
        status: 'completed',
      })
    }
    // thinking / image / tool_result / unknown → dropped
  }
  const usage: Record<string, unknown> = {
    input_tokens: ir.usage.in,
    output_tokens: ir.usage.out,
    total_tokens: ir.usage.in + ir.usage.out,
  }
  if (ir.usage.cacheRead != null) {
    usage.input_tokens_details = { cached_tokens: ir.usage.cacheRead }
  }
  // The Responses API has no per-turn finish reason — only a coarse `status`.
  // `max_tokens` maps to `incomplete`; every other canonical stop reason
  // (end_turn / tool_use / stop_sequence) is just a completed response.
  const incomplete = ir.stopReason === 'max_tokens'
  return {
    id: `resp_${nanoid()}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: ir.model,
    status: incomplete ? 'incomplete' : 'completed',
    ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    output,
    usage,
  }
}

// ── helpers ───────────────────────────────────────────────────────

function userPart(b: IRBlock): unknown {
  if (b.type === 'image') {
    return { type: 'input_image', image_url: imageSourceToUrl(b.source) }
  }
  return { type: 'input_text', text: (b as { text: string }).text }
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
