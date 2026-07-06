// SSE synthesis for the buffered orchestrator paths. A chain or a vision loop
// finishes the upstream call(s) before it has a final answer, so a
// `stream: true` client cannot be true-streamed. Instead the buffered
// IRResponse is rendered into a minimal-but-valid SSE byte string in the
// *client's* wire format — enough for that protocol's stream decoder to
// reconstruct the response. Each synth function round-trips through its
// matching parser (see synth-sse.test.ts).

import { nanoid } from 'nanoid'
import type { ModelApi } from '../../core/model-registry.ts'
import type { NormalizedBlock } from '../../core/packet.ts'
import { type IRResponse, serializeResponseFromIR } from '../translate/index.ts'
import { openaiStopReason } from '../translate/ir.ts'
import {
  LOCAL_SHELL_TOOL,
  freeformInputText,
  inputToShellAction,
  stringifyToolArgs,
} from '../translate/shared.ts'

type SseEvent = { event?: string; data: string }

/** Frame events as SSE: an optional `event:` line, a `data:` line, and a
 *  blank line per event; the whole string ends with a blank line. */
function serialize(events: SseEvent[]): string {
  const lines: string[] = []
  for (const e of events) {
    if (e.event) lines.push(`event: ${e.event}`)
    lines.push(`data: ${e.data}`)
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}

/** Render a buffered IRResponse as a complete SSE stream in the client's wire
 *  format. The output re-parses through that protocol's stream decoder. */
export function synthesizeSse(clientApi: ModelApi, ir: IRResponse): string {
  if (clientApi === 'anthropic-messages') return synthAnthropic(ir)
  if (clientApi === 'openai-chat') return synthOpenAIChat(ir)
  return synthOpenAIResponses(ir)
}

// ── Anthropic Messages ────────────────────────────────────────────

function synthAnthropic(ir: IRResponse): string {
  const events: SseEvent[] = []
  const usage: Record<string, number> = { input_tokens: ir.usage.in, output_tokens: 0 }
  if (ir.usage.cacheRead != null) usage.cache_read_input_tokens = ir.usage.cacheRead
  if (ir.usage.cacheWrite != null) usage.cache_creation_input_tokens = ir.usage.cacheWrite

  events.push({
    event: 'message_start',
    data: JSON.stringify({
      type: 'message_start',
      message: {
        id: `msg_${nanoid()}`,
        type: 'message',
        role: 'assistant',
        model: ir.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    }),
  })

  let index = 0
  for (const b of ir.blocks) {
    const parts = anthropicBlock(b)
    if (!parts) continue
    events.push({
      event: 'content_block_start',
      data: JSON.stringify({ type: 'content_block_start', index, content_block: parts.block }),
    })
    events.push({
      event: 'content_block_delta',
      data: JSON.stringify({ type: 'content_block_delta', index, delta: parts.delta }),
    })
    events.push({
      event: 'content_block_stop',
      data: JSON.stringify({ type: 'content_block_stop', index }),
    })
    index++
  }

  events.push({
    event: 'message_delta',
    data: JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: ir.stopReason ?? 'end_turn', stop_sequence: null },
      usage: { output_tokens: ir.usage.out },
    }),
  })
  events.push({ event: 'message_stop', data: JSON.stringify({ type: 'message_stop' }) })
  return serialize(events)
}

/** The start/delta pair for one block; image/tool_result/unknown have no
 *  Anthropic streaming representation and are skipped. */
function anthropicBlock(b: NormalizedBlock): { block: unknown; delta: unknown } | undefined {
  if (b.type === 'text') {
    return { block: { type: 'text', text: '' }, delta: { type: 'text_delta', text: b.text } }
  }
  if (b.type === 'tool_use') {
    return {
      block: { type: 'tool_use', id: b.id, name: b.name, input: {} },
      delta: { type: 'input_json_delta', partial_json: stringifyToolArgs(b.input) },
    }
  }
  if (b.type === 'thinking') {
    return {
      block: { type: 'thinking', thinking: '' },
      delta: { type: 'thinking_delta', thinking: b.text },
    }
  }
  return undefined
}

// ── OpenAI Chat Completions ───────────────────────────────────────

function synthOpenAIChat(ir: IRResponse): string {
  const id = `chatcmpl-${nanoid()}`
  const created = Math.floor(Date.now() / 1000)
  const events: SseEvent[] = []
  const chunk = (choices: unknown[], usage?: unknown): void => {
    const data: Record<string, unknown> = {
      id,
      object: 'chat.completion.chunk',
      created,
      model: ir.model,
      choices,
    }
    if (usage) data.usage = usage
    events.push({ data: JSON.stringify(data) })
  }

  chunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }])
  let toolIndex = 0
  for (const b of ir.blocks) {
    if (b.type === 'text') {
      chunk([{ index: 0, delta: { content: b.text }, finish_reason: null }])
    } else if (b.type === 'tool_use') {
      chunk([
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: toolIndex,
                id: b.id,
                type: 'function',
                function: { name: b.name, arguments: stringifyToolArgs(b.input) },
              },
            ],
          },
          finish_reason: null,
        },
      ])
      toolIndex++
    }
  }
  chunk([{ index: 0, delta: {}, finish_reason: openaiStopReason(ir.stopReason) }])

  const usage: Record<string, unknown> = {
    prompt_tokens: ir.usage.in,
    completion_tokens: ir.usage.out,
    total_tokens: ir.usage.in + ir.usage.out,
  }
  if (ir.usage.cacheRead != null) {
    usage.prompt_tokens_details = { cached_tokens: ir.usage.cacheRead }
  }
  chunk([], usage)
  events.push({ data: '[DONE]' })
  return serialize(events)
}

// ── OpenAI Responses ──────────────────────────────────────────────

// Emits the full OpenAI Responses event sequence (response.created →
// in_progress → per-item added/delta/done → completed) with consistent
// `id`, `item_id`, `output_index`, `content_index` fields. The previous
// sparse version (model-only response, deltas with no item_id) round-trips
// through afw's own lenient parser but is dropped by codex's strict
// parser — codex would see nothing in the terminal.
function synthOpenAIResponses(ir: IRResponse): string {
  const events: SseEvent[] = []
  let seq = 0
  const responseId = `resp_${nanoid()}`
  const createdAt = Math.floor(Date.now() / 1000)

  type Item =
    | { kind: 'message'; id: string; text: string }
    | { kind: 'function_call'; id: string; callId: string; name: string; argsStr: string }
    | { kind: 'local_shell_call'; id: string; callId: string; action: unknown }
    | { kind: 'custom_tool_call'; id: string; callId: string; name: string; input: string }
  const items: Item[] = []
  for (const b of ir.blocks) {
    if (b.type === 'text') {
      items.push({ kind: 'message', id: `msg_${nanoid()}`, text: b.text })
    } else if (b.type === 'tool_use' && b.freeform) {
      // The client registered this as a freeform `custom` tool — emit a
      // custom_tool_call carrying the raw payload, not a function_call.
      items.push({
        kind: 'custom_tool_call',
        id: `ctc_${nanoid()}`,
        callId: b.id || `call_${nanoid()}`,
        name: b.name,
        input: freeformInputText(b.input),
      })
    } else if (b.type === 'tool_use' && b.name === LOCAL_SHELL_TOOL) {
      // codex's shell built-in — emit a local_shell_call item, not a
      // function_call codex has no tool for (mirrors the true-stream writer).
      items.push({
        kind: 'local_shell_call',
        id: `lsh_${nanoid()}`,
        callId: b.id || `call_${nanoid()}`,
        action: inputToShellAction(b.input),
      })
    } else if (b.type === 'tool_use') {
      items.push({
        kind: 'function_call',
        id: `fc_${nanoid()}`,
        callId: b.id || `call_${nanoid()}`,
        name: b.name,
        argsStr: stringifyToolArgs(b.input),
      })
    }
    // thinking / image / tool_result are dropped — matches responseFromIR.
  }

  const usage: Record<string, unknown> = {
    input_tokens: ir.usage.in,
    output_tokens: ir.usage.out,
    total_tokens: ir.usage.in + ir.usage.out,
  }
  if (ir.usage.cacheRead != null) {
    usage.input_tokens_details = { cached_tokens: ir.usage.cacheRead }
  }
  const incomplete = ir.stopReason === 'max_tokens'

  const finishedOutput = (): unknown[] =>
    items.map((it) => {
      if (it.kind === 'message') {
        return {
          id: it.id,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: it.text, annotations: [] }],
        }
      }
      if (it.kind === 'local_shell_call') {
        return {
          id: it.id,
          type: 'local_shell_call',
          status: 'completed',
          call_id: it.callId,
          action: it.action,
        }
      }
      if (it.kind === 'custom_tool_call') {
        return {
          id: it.id,
          type: 'custom_tool_call',
          status: 'completed',
          call_id: it.callId,
          name: it.name,
          input: it.input,
        }
      }
      return {
        id: it.id,
        type: 'function_call',
        status: 'completed',
        arguments: it.argsStr,
        call_id: it.callId,
        name: it.name,
      }
    })

  const baseResponse = (
    status: 'in_progress' | 'completed' | 'incomplete',
  ): Record<string, unknown> => ({
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    model: ir.model,
    output: status === 'in_progress' ? [] : finishedOutput(),
    usage,
    ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
  })

  events.push({
    event: 'response.created',
    data: JSON.stringify({
      type: 'response.created',
      sequence_number: seq++,
      response: baseResponse('in_progress'),
    }),
  })
  events.push({
    event: 'response.in_progress',
    data: JSON.stringify({
      type: 'response.in_progress',
      sequence_number: seq++,
      response: baseResponse('in_progress'),
    }),
  })

  for (let outputIndex = 0; outputIndex < items.length; outputIndex++) {
    const it = items[outputIndex]!
    if (it.kind === 'message') {
      events.push({
        event: 'response.output_item.added',
        data: JSON.stringify({
          type: 'response.output_item.added',
          sequence_number: seq++,
          output_index: outputIndex,
          item: {
            id: it.id,
            type: 'message',
            status: 'in_progress',
            role: 'assistant',
            content: [],
          },
        }),
      })
      events.push({
        event: 'response.content_part.added',
        data: JSON.stringify({
          type: 'response.content_part.added',
          sequence_number: seq++,
          item_id: it.id,
          output_index: outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }),
      })
      events.push({
        event: 'response.output_text.delta',
        data: JSON.stringify({
          type: 'response.output_text.delta',
          sequence_number: seq++,
          item_id: it.id,
          output_index: outputIndex,
          content_index: 0,
          delta: it.text,
        }),
      })
      events.push({
        event: 'response.output_text.done',
        data: JSON.stringify({
          type: 'response.output_text.done',
          sequence_number: seq++,
          item_id: it.id,
          output_index: outputIndex,
          content_index: 0,
          text: it.text,
        }),
      })
      events.push({
        event: 'response.content_part.done',
        data: JSON.stringify({
          type: 'response.content_part.done',
          sequence_number: seq++,
          item_id: it.id,
          output_index: outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: it.text, annotations: [] },
        }),
      })
      events.push({
        event: 'response.output_item.done',
        data: JSON.stringify({
          type: 'response.output_item.done',
          sequence_number: seq++,
          output_index: outputIndex,
          item: {
            id: it.id,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: it.text, annotations: [] }],
          },
        }),
      })
    } else if (it.kind === 'local_shell_call') {
      // codex's shell built-in has no streamed arguments channel — its argv is
      // delivered whole in the action on added + done.
      events.push({
        event: 'response.output_item.added',
        data: JSON.stringify({
          type: 'response.output_item.added',
          sequence_number: seq++,
          output_index: outputIndex,
          item: {
            id: it.id,
            type: 'local_shell_call',
            status: 'in_progress',
            call_id: it.callId,
            action: it.action,
          },
        }),
      })
      events.push({
        event: 'response.output_item.done',
        data: JSON.stringify({
          type: 'response.output_item.done',
          sequence_number: seq++,
          output_index: outputIndex,
          item: {
            id: it.id,
            type: 'local_shell_call',
            status: 'completed',
            call_id: it.callId,
            action: it.action,
          },
        }),
      })
    } else if (it.kind === 'custom_tool_call') {
      // Freeform tool — its payload is delivered whole via input-delta + done,
      // then the completed item (mirrors codex's own custom_tool_call stream).
      events.push({
        event: 'response.output_item.added',
        data: JSON.stringify({
          type: 'response.output_item.added',
          sequence_number: seq++,
          output_index: outputIndex,
          item: {
            id: it.id,
            type: 'custom_tool_call',
            status: 'in_progress',
            call_id: it.callId,
            name: it.name,
            input: '',
          },
        }),
      })
      events.push({
        event: 'response.custom_tool_call_input.delta',
        data: JSON.stringify({
          type: 'response.custom_tool_call_input.delta',
          sequence_number: seq++,
          item_id: it.id,
          output_index: outputIndex,
          delta: it.input,
        }),
      })
      events.push({
        event: 'response.custom_tool_call_input.done',
        data: JSON.stringify({
          type: 'response.custom_tool_call_input.done',
          sequence_number: seq++,
          item_id: it.id,
          output_index: outputIndex,
          input: it.input,
        }),
      })
      events.push({
        event: 'response.output_item.done',
        data: JSON.stringify({
          type: 'response.output_item.done',
          sequence_number: seq++,
          output_index: outputIndex,
          item: {
            id: it.id,
            type: 'custom_tool_call',
            status: 'completed',
            call_id: it.callId,
            name: it.name,
            input: it.input,
          },
        }),
      })
    } else {
      events.push({
        event: 'response.output_item.added',
        data: JSON.stringify({
          type: 'response.output_item.added',
          sequence_number: seq++,
          output_index: outputIndex,
          item: {
            id: it.id,
            type: 'function_call',
            status: 'in_progress',
            arguments: '',
            call_id: it.callId,
            name: it.name,
          },
        }),
      })
      events.push({
        event: 'response.function_call_arguments.delta',
        data: JSON.stringify({
          type: 'response.function_call_arguments.delta',
          sequence_number: seq++,
          item_id: it.id,
          output_index: outputIndex,
          delta: it.argsStr,
        }),
      })
      events.push({
        event: 'response.function_call_arguments.done',
        data: JSON.stringify({
          type: 'response.function_call_arguments.done',
          sequence_number: seq++,
          item_id: it.id,
          output_index: outputIndex,
          arguments: it.argsStr,
        }),
      })
      events.push({
        event: 'response.output_item.done',
        data: JSON.stringify({
          type: 'response.output_item.done',
          sequence_number: seq++,
          output_index: outputIndex,
          item: {
            id: it.id,
            type: 'function_call',
            status: 'completed',
            arguments: it.argsStr,
            call_id: it.callId,
            name: it.name,
          },
        }),
      })
    }
  }

  events.push({
    event: 'response.completed',
    data: JSON.stringify({
      type: 'response.completed',
      sequence_number: seq++,
      response: baseResponse(incomplete ? 'incomplete' : 'completed'),
    }),
  })
  return serialize(events)
}
