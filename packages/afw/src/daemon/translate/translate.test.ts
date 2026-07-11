import { describe, expect, it } from 'vitest'
import type { ModelApi } from '../../core/model-registry.ts'
import {
  type IRRequest,
  type IRResponse,
  parseRequestToIR,
  parseResponseToIR,
  serializeRequestFromIR,
  serializeResponseFromIR,
  translateRequest,
  translateResponseJson,
} from './index.ts'
import { normalizeToolCallNames } from './ir.ts'

const APIS: ModelApi[] = ['anthropic-messages', 'openai-chat', 'openai-responses']

describe('tool-call name normalization', () => {
  it('maps a GLM SDK-style alias to the registered Codex tool', () => {
    const blocks: IRResponse['blocks'] = [
      {
        type: 'tool_use',
        id: 'call_1',
        name: 'tool_search.tools_search',
        input: { query: 'list all available MCP tools' },
      },
    ]

    expect(normalizeToolCallNames(blocks, ['tool_search'])).toBe(1)
    expect(blocks[0]).toMatchObject({
      name: 'tool_search',
      input: { query: 'list all available MCP tools' },
    })
  })

  it('preserves exact and unknown names', () => {
    const blocks: IRResponse['blocks'] = [
      { type: 'tool_use', id: 'call_1', name: 'server.search', input: {} },
      { type: 'tool_use', id: 'call_2', name: 'other.search', input: {} },
    ]

    expect(normalizeToolCallNames(blocks, ['server.search', 'tool_search'])).toBe(0)
    expect(blocks.map((block) => (block.type === 'tool_use' ? block.name : ''))).toEqual([
      'server.search',
      'other.search',
    ])
  })
})

// A request exercising every block kind that survives all three protocols:
// text, top-level image, tool_use, tool_result, a mixed user turn, tools.
const CANONICAL_REQUEST: IRRequest = {
  model: 'test-model',
  system: 'You are a helpful assistant.',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this image?' },
        { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'aGVsbG8=' } },
      ],
    },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me look it up.' },
        { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'SF' } },
      ],
    },
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolUseId: 'call_1',
          content: [{ type: 'text', text: 'Sunny, 72F' }],
        },
        { type: 'text', text: 'Thanks!' },
      ],
    },
  ],
  tools: [
    {
      name: 'get_weather',
      description: 'Get the weather for a city',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  ],
  maxTokens: 1024,
  temperature: 0.7,
  stream: false,
}

// `max_tokens` is the one stop reason expressible in all three protocols
// (Anthropic `stop_reason`, Chat `finish_reason:length`, Responses
// `status:incomplete`) — so it round-trips cleanly through the matrix.
const CANONICAL_RESPONSE: IRResponse = {
  model: 'test-model',
  blocks: [
    { type: 'text', text: 'The weather is sunny.' },
    { type: 'tool_use', id: 'call_9', name: 'lookup', input: { q: 'x' } },
  ],
  stopReason: 'max_tokens',
  usage: { in: 100, out: 50, cacheRead: 20 },
}

/** Drop `rawJson` — set by the OpenAI parsers, absent from the Anthropic one. */
function stripRawJson(ir: IRResponse): IRResponse {
  return {
    ...ir,
    blocks: ir.blocks.map((b) =>
      b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input } : b,
    ),
  }
}

describe('translateRequest / translateResponseJson identity', () => {
  it('returns the same request body when source and target match', () => {
    const body = serializeRequestFromIR('openai-chat', CANONICAL_REQUEST)
    expect(translateRequest('openai-chat', 'openai-chat', body)).toBe(body)
  })

  it('returns the same response JSON when source and target match', () => {
    const json = serializeResponseFromIR('anthropic-messages', CANONICAL_RESPONSE)
    expect(translateResponseJson('anthropic-messages', 'anthropic-messages', json)).toBe(json)
  })
})

describe('tool_choice translation (Anthropic → OpenAI-chat)', () => {
  function anthropicReqWith(tc: unknown) {
    return {
      model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'web_search', input_schema: { type: 'object' } }],
      tool_choice: tc,
    }
  }

  function translatedOpenAI(tc: unknown): { tool_choice: unknown } {
    const wire = anthropicReqWith(tc)
    return translateRequest('anthropic-messages', 'openai-chat', wire) as {
      tool_choice: unknown
    }
  }

  it('maps {type:"tool", name:"X"} to OpenAI {type:"function", function:{name:"X"}}', () => {
    expect(translatedOpenAI({ type: 'tool', name: 'web_search' }).tool_choice).toEqual({
      type: 'function',
      function: { name: 'web_search' },
    })
  })

  it('maps "any" to "required" and the rest pass through verbatim', () => {
    expect(translatedOpenAI({ type: 'auto' }).tool_choice).toBe('auto')
    expect(translatedOpenAI({ type: 'any' }).tool_choice).toBe('required')
    expect(translatedOpenAI({ type: 'none' }).tool_choice).toBe('none')
  })

  it('omits tool_choice from the OpenAI body when source has none', () => {
    const wire = {
      model: 'claude-x',
      messages: [{ role: 'user', content: 'hi' }],
    }
    const obj = translateRequest('anthropic-messages', 'openai-chat', wire) as Record<
      string,
      unknown
    >
    expect('tool_choice' in obj).toBe(false)
  })
})

describe('request translation matrix', () => {
  for (const from of APIS) {
    for (const to of APIS) {
      it(`preserves the request IR: ${from} → ${to}`, () => {
        const wire = serializeRequestFromIR(from, CANONICAL_REQUEST)
        const translated = translateRequest(from, to, wire)
        expect(parseRequestToIR(to, translated)).toEqual(CANONICAL_REQUEST)
      })
    }
  }
})

describe('response translation matrix', () => {
  for (const from of APIS) {
    for (const to of APIS) {
      it(`preserves the response IR: ${from} → ${to}`, () => {
        const wire = serializeResponseFromIR(from, CANONICAL_RESPONSE)
        const translated = translateResponseJson(from, to, wire)
        const ir = parseResponseToIR(to, translated)
        expect(stripRawJson(ir)).toEqual(stripRawJson(CANONICAL_RESPONSE))
      })
    }
  }
})

describe('request serialization shape', () => {
  it('Anthropic output always carries max_tokens', () => {
    const noLimit: IRRequest = { ...CANONICAL_REQUEST, maxTokens: undefined }
    const wire = serializeRequestFromIR('anthropic-messages', noLimit) as { max_tokens: number }
    expect(wire.max_tokens).toBe(4096)
  })

  it('routes tool schemas to each protocol field name', () => {
    const anthropic = serializeRequestFromIR('anthropic-messages', CANONICAL_REQUEST) as {
      tools: Array<{ input_schema: unknown }>
    }
    expect(anthropic.tools[0]?.input_schema).toMatchObject({ type: 'object' })

    const chat = serializeRequestFromIR('openai-chat', CANONICAL_REQUEST) as {
      tools: Array<{ type: string; function: { parameters: unknown } }>
    }
    expect(chat.tools[0]?.type).toBe('function')
    expect(chat.tools[0]?.function.parameters).toMatchObject({ type: 'object' })

    const responses = serializeRequestFromIR('openai-responses', CANONICAL_REQUEST) as {
      tools: Array<{ type: string; name: string; parameters: unknown }>
    }
    expect(responses.tools[0]?.name).toBe('get_weather')
    expect(responses.tools[0]?.parameters).toMatchObject({ type: 'object' })
  })

  it('turns a tool_result into a standalone role:tool message for Chat', () => {
    const wire = serializeRequestFromIR('openai-chat', CANONICAL_REQUEST) as {
      messages: Array<{ role: string; tool_call_id?: string; content?: unknown }>
    }
    const toolMsg = wire.messages.find((m) => m.role === 'tool')
    expect(toolMsg?.tool_call_id).toBe('call_1')
    expect(toolMsg?.content).toBe('Sunny, 72F')
  })

  it('unrolls turns into a flat input stream for Responses', () => {
    const wire = serializeRequestFromIR('openai-responses', CANONICAL_REQUEST) as {
      instructions: string
      input: Array<{ type: string }>
    }
    expect(wire.instructions).toBe('You are a helpful assistant.')
    expect(wire.input.map((i) => i.type)).toEqual([
      'message',
      'message',
      'function_call',
      'function_call_output',
      'message',
    ])
  })
})

describe('request parsing edge cases', () => {
  it('flattens an Anthropic array-form system prompt', () => {
    const ir = parseRequestToIR('anthropic-messages', {
      model: 'm',
      max_tokens: 10,
      system: [
        { type: 'text', text: 'Line one.' },
        { type: 'text', text: 'Line two.' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(ir.system).toBe('Line one.\nLine two.')
  })

  it('merges consecutive Chat tool messages into one user turn', () => {
    const ir = parseRequestToIR('openai-chat', {
      model: 'm',
      messages: [
        { role: 'assistant', content: null, tool_calls: [] },
        { role: 'tool', tool_call_id: 't1', content: 'a' },
        { role: 'tool', tool_call_id: 't2', content: 'b' },
      ],
    })
    const last = ir.messages[ir.messages.length - 1]
    expect(last?.role).toBe('user')
    expect(last?.content).toHaveLength(2)
    expect(last?.content.every((b) => b.type === 'tool_result')).toBe(true)
  })

  it('decodes a base64 data URI back to an image source', () => {
    const ir = parseRequestToIR('openai-chat', {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/jpeg;base64,Zm9v' },
            },
          ],
        },
      ],
    })
    expect(ir.messages[0]?.content[0]).toEqual({
      type: 'image',
      source: { kind: 'base64', mediaType: 'image/jpeg', data: 'Zm9v' },
    })
  })
})

describe('codex local_shell built-in (Responses → Chat)', () => {
  // Codex ships its shell capability as the Responses *built-in* `local_shell`
  // tool — `{type:"local_shell"}`, no `name`. A chat-completions backend has no
  // built-in equivalent, so it must surface as a callable function tool.
  const CODEX_REQUEST = {
    model: 'gpt-5-codex',
    instructions: 'You are a coding agent.',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ls /tmp' }] }],
    tools: [
      { type: 'local_shell' },
      { type: 'function', name: 'apply_patch', parameters: { type: 'object' } },
    ],
    stream: false,
  }

  it('exposes local_shell as a callable function tool, not dropped', () => {
    const ir = parseRequestToIR('openai-responses', CODEX_REQUEST)
    const names = (ir.tools ?? []).map((t) => t.name)
    expect(names).toContain('local_shell')
    expect(names).toContain('apply_patch')
  })

  it('translates the request so the chat backend sees both tools', () => {
    const chat = translateRequest('openai-responses', 'openai-chat', CODEX_REQUEST) as {
      tools: Array<{ type: string; function: { name: string } }>
    }
    const names = chat.tools.map((t) => t.function.name)
    expect(names).toEqual(['local_shell', 'apply_patch'])
  })

  it('turns the chat tool call back into a local_shell_call codex understands', () => {
    // A chat backend calls the synthetic `local_shell` function…
    const chatResponse = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_42',
                type: 'function',
                function: { name: 'local_shell', arguments: '{"command":["ls","/tmp"]}' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    }
    const responses = translateResponseJson(
      'openai-chat',
      'openai-responses',
      chatResponse,
    ) as { output: Array<Record<string, unknown>> }
    const shell = responses.output.find((o) => o.type === 'local_shell_call')
    expect(shell).toBeDefined()
    expect(shell?.call_id).toBe('call_42')
    expect(shell?.action).toMatchObject({ type: 'exec', command: ['ls', '/tmp'] })
    // No stray function_call item leaks through for the built-in.
    expect(responses.output.some((o) => o.type === 'function_call')).toBe(false)
  })

  it('preserves sandbox approval metadata on a local_shell call', () => {
    const chatResponse = {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_approval',
                type: 'function',
                function: {
                  name: 'local_shell',
                  arguments: JSON.stringify({
                    command: ['curl', '-L', 'https://example.com/archive.tar.gz'],
                    sandbox_permissions: 'require_escalated',
                    justification: 'Allow this download?',
                    prefix_rule: ['curl', '-L'],
                  }),
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    }
    const responses = translateResponseJson(
      'openai-chat',
      'openai-responses',
      chatResponse,
    ) as { output: Array<Record<string, unknown>> }
    const shell = responses.output.find((o) => o.type === 'local_shell_call')
    expect(shell?.action).toMatchObject({
      type: 'exec',
      command: ['curl', '-L', 'https://example.com/archive.tar.gz'],
      sandbox_permissions: 'require_escalated',
      justification: 'Allow this download?',
      prefix_rule: ['curl', '-L'],
    })
  })

  it('folds a prior local_shell_call / output pair back into the IR history', () => {
    const ir = parseRequestToIR('openai-responses', {
      model: 'gpt-5-codex',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'ls' }] },
        {
          type: 'local_shell_call',
          call_id: 'call_7',
          action: { type: 'exec', command: ['ls', '-la'] },
        },
        { type: 'local_shell_call_output', call_id: 'call_7', output: 'file-a\nfile-b' },
      ],
      tools: [{ type: 'local_shell' }],
    })
    const toolUse = ir.messages
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_use')
    const toolResult = ir.messages
      .flatMap((m) => m.content)
      .find((b) => b.type === 'tool_result')
    expect(toolUse).toMatchObject({ name: 'local_shell', id: 'call_7' })
    expect((toolUse as { input: { command: string[] } }).input.command).toEqual(['ls', '-la'])
    expect(toolResult).toMatchObject({ toolUseId: 'call_7' })
  })
})

describe('stop reason mapping', () => {
  it('round-trips end_turn / tool_use between Anthropic and Chat', () => {
    for (const reason of ['end_turn', 'tool_use', 'max_tokens']) {
      const resp: IRResponse = { ...CANONICAL_RESPONSE, stopReason: reason }
      const wire = serializeResponseFromIR('anthropic-messages', resp)
      const back = parseResponseToIR(
        'openai-chat',
        translateResponseJson('anthropic-messages', 'openai-chat', wire),
      )
      expect(back.stopReason).toBe(reason)
    }
  })
})

describe('lossy directions', () => {
  it('drops thinking blocks when targeting OpenAI Chat', () => {
    const withThinking: IRResponse = {
      ...CANONICAL_RESPONSE,
      blocks: [
        { type: 'thinking', text: 'secret reasoning' },
        { type: 'text', text: 'visible answer' },
      ],
    }
    const wire = serializeResponseFromIR('openai-chat', withThinking)
    const back = parseResponseToIR('openai-chat', wire)
    expect(back.blocks.some((b) => b.type === 'thinking')).toBe(false)
    expect(back.blocks).toContainEqual({ type: 'text', text: 'visible answer' })
  })

  it('loses a non-truncation stop reason through OpenAI Responses', () => {
    const resp: IRResponse = { ...CANONICAL_RESPONSE, stopReason: 'tool_use' }
    const wire = serializeResponseFromIR('anthropic-messages', resp)
    const back = parseResponseToIR(
      'openai-responses',
      translateResponseJson('anthropic-messages', 'openai-responses', wire),
    )
    expect(back.stopReason).toBeUndefined()
  })
})

describe('inline-XML tool calls in an OpenAI Responses message', () => {
  // A model behind a Responses endpoint that emits its tool call as inline
  // GLM XML inside an assistant message, not a native function_call item —
  // the shape captured from the codex → xiangxinai trace.
  const responseWithXmlCall = {
    model: 'og-coding',
    status: 'completed',
    output: [
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'let me edit' }] },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: '<tool_call>apply_patch<arg_key>file</arg_key><arg_value>/tmp/x.md</arg_value><arg_key>content</arg_key><arg_value># hi</arg_value></tool_call>',
          },
        ],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 20 },
  }

  it('promotes the inline XML into a real tool_use block', () => {
    const ir = parseResponseToIR('openai-responses', responseWithXmlCall)
    const tool = ir.blocks.find((b) => b.type === 'tool_use')
    expect(tool).toMatchObject({
      name: 'apply_patch',
      input: { file: '/tmp/x.md', content: '# hi' },
    })
    // The raw XML must not survive as visible text.
    expect(ir.blocks.some((b) => b.type === 'text' && b.text.includes('<tool_call>'))).toBe(false)
    expect(ir.stopReason).toBe('tool_use')
  })

  it('re-serializes to a Responses SSE stream carrying a function_call item', () => {
    const ir = parseResponseToIR('openai-responses', responseWithXmlCall)
    const wire = serializeResponseFromIR('openai-responses', ir)
    const text = typeof wire === 'string' ? wire : JSON.stringify(wire)
    expect(text).toContain('function_call')
    expect(text).toContain('apply_patch')
  })

  it("promotes GLM's unterminated bare call into a Responses function_call", () => {
    const ir = parseResponseToIR('openai-responses', {
      model: 'GLM-5.2',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: '让我看看当前环境。<tool_call>functions.collaboration.list_agents',
            },
          ],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    expect(ir.blocks).toEqual([
      { type: 'text', text: '让我看看当前环境。' },
      expect.objectContaining({
        type: 'tool_use',
        name: 'functions.collaboration.list_agents',
        input: {},
      }),
    ])
    expect(ir.stopReason).toBe('tool_use')
    expect(JSON.stringify(serializeResponseFromIR('openai-responses', ir))).toContain(
      'function_call',
    )
  })

  it('promotes the unterminated JavaScript-shaped MCP call from the real trace', () => {
    const ir = parseResponseToIR('openai-responses', {
      model: 'GLM-5.2',
      status: 'completed',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: '好，我来实际调用一个 MCP 工具给你看看。<tool_call>tool_search.perform_search({ "query": "", "limit": 50 })',
            },
          ],
        },
      ],
      usage: { input_tokens: 10, output_tokens: 12 },
    })

    expect(ir.blocks).toEqual([
      { type: 'text', text: '好，我来实际调用一个 MCP 工具给你看看。' },
      expect.objectContaining({
        type: 'tool_use',
        name: 'tool_search.perform_search',
        input: { query: '', limit: 50 },
      }),
    ])
    expect(ir.stopReason).toBe('tool_use')
  })
})

describe('freeform (custom) tool round-trip', () => {
  const codexRequest = {
    model: 'gpt-5',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'edit it' }] }],
    tools: [
      {
        type: 'custom',
        name: 'apply_patch',
        description: 'Use apply_patch to edit files. This is a FREEFORM tool.',
        format: { type: 'grammar', syntax: 'lark', definition: 'start: "*** Begin Patch"' },
      },
    ],
    stream: true,
  }

  it('decodes a custom tool as freeform with its grammar', () => {
    const ir = parseRequestToIR('openai-responses', codexRequest)
    const tool = ir.tools?.find((t) => t.name === 'apply_patch')
    expect(tool?.freeform).toBe(true)
    expect(tool?.grammar).toContain('Begin Patch')
  })

  it('exposes the freeform tool to a chat/responses upstream as a single-input function', () => {
    const ir = parseRequestToIR('openai-responses', codexRequest)
    for (const api of ['openai-chat', 'openai-responses', 'anthropic-messages'] as const) {
      const wire = JSON.stringify(serializeRequestFromIR(api, ir))
      const parsed = JSON.parse(wire)
      const tools = api === 'anthropic-messages' ? parsed.tools : parsed.tools
      const t = tools.find((x: { name?: string; function?: { name?: string } }) =>
        (x.name ?? x.function?.name) === 'apply_patch',
      )
      const schema = t.parameters ?? t.function?.parameters ?? t.input_schema
      expect(schema.properties.input.type).toBe('string')
      expect(schema.required).toContain('input')
      const desc = t.description ?? t.function?.description
      expect(desc).toContain('Begin Patch') // grammar folded in
    }
  })

  it('decodes a custom_tool_call in history as {input} shape', () => {
    const req = {
      model: 'gpt-5',
      input: [
        { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch' },
        { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' },
      ],
    }
    const ir = parseRequestToIR('openai-responses', req)
    const asst = ir.messages.find((m) => m.role === 'assistant')
    const call = asst?.content.find((b) => b.type === 'tool_use') as { input: unknown } | undefined
    expect(call?.input).toEqual({ input: '*** Begin Patch\n*** End Patch' })
  })

  it('re-emits a freeform tool_use as a custom_tool_call, not a function_call', () => {
    const ir: IRResponse = {
      model: 'og-coding',
      blocks: [
        {
          type: 'tool_use',
          id: 'call_1',
          name: 'apply_patch',
          input: { input: '*** Begin Patch\n*** End Patch' },
          freeform: true,
        },
      ],
      stopReason: 'tool_use',
      usage: { in: 1, out: 1 },
    }
    const wire = JSON.stringify(serializeResponseFromIR('openai-responses', ir))
    const parsed = JSON.parse(wire)
    const item = parsed.output.find((o: { type: string }) => o.type === 'custom_tool_call')
    expect(item).toBeDefined()
    expect(item.name).toBe('apply_patch')
    expect(item.input).toBe('*** Begin Patch\n*** End Patch')
    expect(parsed.output.some((o: { type: string }) => o.type === 'function_call')).toBe(false)
  })
})

describe('synthesized tool-call ids are unique across turns', () => {
  const xmlResponse = (patch: string) => ({
    model: 'og-coding',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: `<tool_call>apply_patch<arg_key>definition</arg_key><arg_value>${patch}</arg_value></tool_call>`,
          },
        ],
      },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  })

  it('does not reuse afw_xml_0 for every response (id collision bug)', () => {
    const ir1 = parseResponseToIR('openai-responses', xmlResponse('add'))
    const ir2 = parseResponseToIR('openai-responses', xmlResponse('delete'))
    const id1 = ir1.blocks.find((b) => b.type === 'tool_use')?.id
    const id2 = ir2.blocks.find((b) => b.type === 'tool_use')?.id
    expect(id1).toBeTruthy()
    expect(id2).toBeTruthy()
    expect(id1).not.toBe(id2)
  })
})
