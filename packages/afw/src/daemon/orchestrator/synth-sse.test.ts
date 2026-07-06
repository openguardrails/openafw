import { describe, expect, it } from 'vitest'
import { parseAnthropicStream } from '../decoders/anthropic/sse.ts'
import { parseOpenAIResponsesStream } from '../decoders/openai/responses-sse.ts'
import { parseOpenAIChatStream } from '../decoders/openai/sse.ts'
import type { IRResponse } from '../translate/index.ts'
import { synthesizeSse } from './synth-sse.ts'

function streamOf(s: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(s)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

const IR: IRResponse = {
  model: 'test-model',
  blocks: [
    { type: 'text', text: 'Hello world' },
    { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Paris' } },
  ],
  stopReason: 'tool_use',
  usage: { in: 10, out: 5, cacheRead: 3 },
}

describe('synthesizeSse', () => {
  it('renders Anthropic SSE that re-parses to the same response', async () => {
    const result = await parseAnthropicStream(streamOf(synthesizeSse('anthropic-messages', IR)))
    expect(result.errors).toEqual([])
    expect(result.model).toBe('test-model')
    expect(result.stopReason).toBe('tool_use')
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(5)

    const text = result.blocks.find((b) => b.type === 'text')
    expect(text).toEqual({ type: 'text', text: 'Hello world' })

    const tool = result.blocks.find((b) => b.type === 'tool_use')
    expect(tool?.type).toBe('tool_use')
    if (tool?.type !== 'tool_use') return
    expect(tool.name).toBe('get_weather')
    expect(tool.input).toEqual({ city: 'Paris' })
  })

  it('renders OpenAI Chat SSE that re-parses to the same response', async () => {
    const result = await parseOpenAIChatStream(streamOf(synthesizeSse('openai-chat', IR)))
    expect(result.errors).toEqual([])
    expect(result.model).toBe('test-model')
    expect(result.finishReason).toBe('tool_calls')
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(5)

    const text = result.blocks.find((b) => b.type === 'text')
    expect(text).toEqual({ type: 'text', text: 'Hello world' })

    const tool = result.blocks.find((b) => b.type === 'tool_use')
    expect(tool?.type).toBe('tool_use')
    if (tool?.type !== 'tool_use') return
    expect(tool.name).toBe('get_weather')
    expect(tool.input).toEqual({ city: 'Paris' })
  })

  it('renders OpenAI Responses SSE that re-parses to the same response', async () => {
    const result = await parseOpenAIResponsesStream(streamOf(synthesizeSse('openai-responses', IR)))
    expect(result.errors).toEqual([])
    expect(result.model).toBe('test-model')
    expect(result.usage.inputTokens).toBe(10)
    expect(result.usage.outputTokens).toBe(5)

    const text = result.blocks.find((b) => b.type === 'text')
    expect(text).toEqual({ type: 'text', text: 'Hello world' })

    const tool = result.blocks.find((b) => b.type === 'tool_use')
    expect(tool?.type).toBe('tool_use')
    if (tool?.type !== 'tool_use') return
    expect(tool.name).toBe('get_weather')
    expect(tool.input).toEqual({ city: 'Paris' })
  })
})

describe('synthesizeSse freeform tool', () => {
  const IR_FREEFORM: IRResponse = {
    model: 'og-coding',
    blocks: [
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'apply_patch',
        input: { input: '*** Begin Patch\n*** Add File: a.txt\n+hi\n*** End Patch' },
        freeform: true,
      },
    ],
    stopReason: 'tool_use',
    usage: { in: 10, out: 5 },
  }

  it('emits a custom_tool_call codex can re-parse, carrying the raw payload', async () => {
    const sse = synthesizeSse('openai-responses', IR_FREEFORM)
    expect(sse).toContain('"type":"custom_tool_call"')
    expect(sse).not.toContain('"type":"function_call"')
    const result = await parseOpenAIResponsesStream(streamOf(sse))
    expect(result.errors).toEqual([])
    const tool = result.blocks.find((b) => b.type === 'tool_use')
    expect(tool?.type).toBe('tool_use')
    if (tool?.type !== 'tool_use') return
    expect(tool.name).toBe('apply_patch')
    expect(tool.input).toContain('*** Begin Patch')
  })
})
