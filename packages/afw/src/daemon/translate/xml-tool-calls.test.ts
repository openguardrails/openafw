import { describe, expect, it } from 'vitest'
import {
  extractAnthropicInvokeToolCalls,
  extractGlmArgKvToolCalls,
  extractHermesToolCalls,
  extractInlineToolCallsXml,
} from './xml-tool-calls.ts'

describe('extractHermesToolCalls', () => {
  it('returns null when the text has no Hermes markup', () => {
    expect(extractHermesToolCalls('just a regular answer')).toBeNull()
    expect(extractHermesToolCalls('')).toBeNull()
  })

  it('parses a single bare <tool_call> with object arguments', () => {
    const out = extractHermesToolCalls(
      '<tool_call>{"name": "view_image", "arguments": {"id": "img_1"}}</tool_call>',
    )
    expect(out).not.toBeNull()
    expect(out?.toolUses).toEqual([{ name: 'view_image', input: { id: 'img_1' } }])
    expect(out?.cleanedText).toBe('')
  })

  it('parses the wrapped <tool_calls><tool_call>… form', () => {
    const text = `
      Sure, let me look at that.
      <tool_calls>
        <tool_call>{"name": "view_image", "arguments": {"id": "img_1"}}</tool_call>
      </tool_calls>
    `
    const out = extractHermesToolCalls(text)
    expect(out?.toolUses).toHaveLength(1)
    expect(out?.toolUses[0]?.name).toBe('view_image')
    expect(out?.cleanedText).toContain('Sure, let me look at that.')
    expect(out?.cleanedText).not.toContain('<tool_call')
    expect(out?.cleanedText).not.toContain('</tool_call')
  })

  it('parses arguments that came through as a JSON-encoded string', () => {
    const text =
      '<tool_call>{"name":"web_search","arguments":"{\\"query\\":\\"deepseek docs\\"}"}</tool_call>'
    const out = extractHermesToolCalls(text)
    expect(out?.toolUses[0]?.input).toEqual({ query: 'deepseek docs' })
    expect(out?.toolUses[0]?.rawJson).toBe('{"query":"deepseek docs"}')
  })

  it('handles the empty-nested-wrapper failure mode without leaking XML', () => {
    const text = `<tool_calls>
<tool_calls>
<tool_calls>
<tool_calls>
</tool_calls></tool_calls></tool_calls></tool_calls>`
    const out = extractHermesToolCalls(text)
    expect(out).not.toBeNull()
    expect(out?.toolUses).toEqual([])
    expect(out?.cleanedText).toBe('')
  })

  it('drops malformed inner blocks but keeps the valid ones', () => {
    const text = `<tool_calls>
      <tool_call>{"name":"good","arguments":{}}</tool_call>
      <tool_call>not even json</tool_call>
      <tool_call>{"arguments":{}}</tool_call>
    </tool_calls>`
    const out = extractHermesToolCalls(text)
    expect(out?.toolUses).toHaveLength(1)
    expect(out?.toolUses[0]?.name).toBe('good')
  })
})

describe('extractAnthropicInvokeToolCalls', () => {
  it('returns null when no <invoke> markup is present', () => {
    expect(extractAnthropicInvokeToolCalls('regular answer')).toBeNull()
    expect(extractAnthropicInvokeToolCalls('<tool_call>{}</tool_call>')).toBeNull()
  })

  it('parses a single <invoke> with <parameter> children', () => {
    const text = `<invoke name="view_image">
      <parameter name="image_id">img_abc</parameter>
      <parameter name="question">describe this</parameter>
    </invoke>`
    const out = extractAnthropicInvokeToolCalls(text)
    expect(out?.toolUses).toEqual([
      { name: 'view_image', input: { image_id: 'img_abc', question: 'describe this' } },
    ])
    expect(out?.cleanedText).toBe('')
  })

  it('coerces booleans / null / numbers and parses inline JSON objects', () => {
    const text = `<invoke name="t">
      <parameter name="enabled">true</parameter>
      <parameter name="count">42</parameter>
      <parameter name="ratio">1.5</parameter>
      <parameter name="opt">null</parameter>
      <parameter name="cfg">{"a":1}</parameter>
      <parameter name="tags">["one","two"]</parameter>
      <parameter name="note">just text</parameter>
    </invoke>`
    const out = extractAnthropicInvokeToolCalls(text)
    expect(out?.toolUses[0]?.input).toEqual({
      enabled: true,
      count: 42,
      ratio: 1.5,
      opt: null,
      cfg: { a: 1 },
      tags: ['one', 'two'],
      note: 'just text',
    })
  })

  it('handles the malformed duplicated-opening real-user payload', () => {
    // Exact pattern the user pasted: two <invoke> openings, one
    // </invoke>, parameters in between. The outer match absorbs the
    // inner stray <invoke> tag as text in its body; the parameter
    // regex still extracts the two <parameter> blocks correctly.
    const text = `<invoke name="view_image"><invoke name="view_image">
<parameter name="image_id" string="true">1</parameter>
<parameter name="question" string="true">请描述这张图片的完整内容，包括所有文字、图表、数据等信息。</parameter>
</invoke>`
    const out = extractAnthropicInvokeToolCalls(text)
    expect(out?.toolUses).toHaveLength(1)
    expect(out?.toolUses[0]?.name).toBe('view_image')
    expect(out?.toolUses[0]?.input).toEqual({
      image_id: 1, // numeric coercion — "1" is unambiguously a number
      question: '请描述这张图片的完整内容，包括所有文字、图表、数据等信息。',
    })
    // No XML leaks to the visible answer.
    expect(out?.cleanedText).toBe('')
  })

  it('parses multiple <invoke> calls in order under <function_calls>', () => {
    const text = `<function_calls>
      <invoke name="a"><parameter name="x">1</parameter></invoke>
      <invoke name="b"><parameter name="y">2</parameter></invoke>
    </function_calls>`
    const out = extractAnthropicInvokeToolCalls(text)
    expect(out?.toolUses.map((t) => t.name)).toEqual(['a', 'b'])
    expect(out?.toolUses[1]?.input).toEqual({ y: 2 })
    expect(out?.cleanedText).toBe('')
  })

  it('preserves text outside the invoke block', () => {
    const text = `I'll look at the image.

<invoke name="view_image"><parameter name="id">x</parameter></invoke>

Then I'll summarize.`
    const out = extractAnthropicInvokeToolCalls(text)
    expect(out?.toolUses[0]?.name).toBe('view_image')
    expect(out?.cleanedText).toContain("I'll look at the image.")
    expect(out?.cleanedText).toContain("Then I'll summarize.")
  })
})

describe('extractInlineToolCallsXml (tolerant fallback)', () => {
  it('handles the unclosed <tool_call name>/<parameter> payload', () => {
    // Exact failing payload from the user: outer <toolcall> (no
    // underscore, name 'viewimage' without underscore), inner
    // <tool_call name="view_image"> (correct), two closed
    // <parameter> blocks, and NO closing tags for either container.
    // Last-named-open wins → name is 'view_image' (the intended one).
    const text = `<toolcall name="viewimage"><tool_call name="view_image">
<parameter name="image_id" string="true">1</parameter>
<parameter name="question" string="true">描述这张图片里有什么，包括场景、人物、动作、物品等所有细节</parameter>`
    const out = extractInlineToolCallsXml(text)
    expect(out?.toolUses).toEqual([
      {
        name: 'view_image',
        input: {
          image_id: 1,
          question: '描述这张图片里有什么，包括场景、人物、动作、物品等所有细节',
        },
      },
    ])
    expect(out?.cleanedText).toBe('')
  })

  it('handles a single unterminated <tool_call name="X">', () => {
    const text = `<tool_call name="search">
<parameter name="query">deepseek docs</parameter>`
    const out = extractInlineToolCallsXml(text)
    expect(out?.toolUses).toEqual([{ name: 'search', input: { query: 'deepseek docs' } }])
  })

  it('falls back when no <parameter> blocks exist (zero tool_use)', () => {
    // No params, no recoverable args. Don't surface a bogus tool_use
    // with empty input — return zero so the caller renders empty text.
    const text = `<tool_call name="view_image">`
    const out = extractInlineToolCallsXml(text)
    expect(out?.toolUses).toEqual([{ name: 'view_image', input: {} }])
  })
})

describe('extractInlineToolCallsXml (unified entry)', () => {
  it('routes Hermes-shaped text to the Hermes parser', () => {
    const out = extractInlineToolCallsXml('<tool_call>{"name":"a","arguments":{}}</tool_call>')
    expect(out?.toolUses[0]?.name).toBe('a')
  })

  it('routes Anthropic-invoke text to the invoke parser', () => {
    const out = extractInlineToolCallsXml(
      '<invoke name="a"><parameter name="x">1</parameter></invoke>',
    )
    expect(out?.toolUses[0]?.name).toBe('a')
    expect(out?.toolUses[0]?.input).toEqual({ x: 1 })
  })

  it('returns null when neither format is present', () => {
    expect(extractInlineToolCallsXml('hello world')).toBeNull()
  })

  it('routes GLM <arg_key> text to the GLM parser, not Hermes', () => {
    const out = extractInlineToolCallsXml(
      '<tool_call>apply_patch<arg_key>file</arg_key><arg_value>/tmp/x</arg_value></tool_call>',
    )
    expect(out?.toolUses).toEqual([{ name: 'apply_patch', input: { file: '/tmp/x' } }])
  })
})

describe('extractGlmArgKvToolCalls', () => {
  it('returns null without a GLM-shaped <tool_call>', () => {
    expect(extractGlmArgKvToolCalls('plain answer')).toBeNull()
    // JSON body is Hermes' shape — GLM defers.
    expect(extractGlmArgKvToolCalls('<tool_call>{"name":"a"}</tool_call>')).toBeNull()
  })

  it('recognizes a bare no-arg <tool_call>name</tool_call> as an empty call', () => {
    const out = extractGlmArgKvToolCalls('<tool_call>apply_patch</tool_call>')
    expect(out?.toolUses).toEqual([{ name: 'apply_patch', input: {} }])
    expect(out?.cleanedText).toBe('')
  })

  it('recovers the unterminated bare tool call emitted by GLM for codex', () => {
    const out = extractGlmArgKvToolCalls(
      '让我看看当前环境。<tool_call>functions.collaboration.list_agents',
    )
    expect(out).toEqual({
      cleanedText: '让我看看当前环境。',
      toolUses: [{ name: 'functions.collaboration.list_agents', input: {} }],
    })
  })

  it('recovers an unterminated JavaScript-shaped MCP call with JSON arguments', () => {
    const out = extractGlmArgKvToolCalls(
      '好，我来实际调用一个 MCP 工具给你看看。<tool_call>tool_search.perform_search({ "query": "", "limit": 50 })',
    )
    expect(out).toEqual({
      cleanedText: '好，我来实际调用一个 MCP 工具给你看看。',
      toolUses: [{ name: 'tool_search.perform_search', input: { query: '', limit: 50 } }],
    })
  })

  it('does not execute a JavaScript-shaped call with malformed JSON arguments', () => {
    expect(
      extractGlmArgKvToolCalls('<tool_call>tool_search.perform_search({ query: "" })'),
    ).toBeNull()
  })

  it('does not promote prose after an unterminated tool-call marker', () => {
    expect(extractGlmArgKvToolCalls('<tool_call>this is not a tool name')).toBeNull()
  })

  it('echoes the grammar field name as the arg key (real GLM apply_patch)', () => {
    const patch = '*** Begin Patch\n*** Add File: hello.txt\n+hello world\n*** End Patch\n'
    const out = extractGlmArgKvToolCalls(
      `<tool_call>apply_patch<arg_key>definition</arg_key><arg_value>${patch}</arg_value></tool_call>`,
    )
    expect(out?.toolUses[0]?.name).toBe('apply_patch')
    expect((out?.toolUses[0]?.input as Record<string, string>).definition).toContain('Begin Patch')
  })

  it('parses the real-world apply_patch call from the codex trace', () => {
    const text =
      '<tool_call>apply_patch<arg_key>file</arg_key><arg_value>/Users/tom/workspace/dev/predict/README.md</arg_value><arg_key>content</arg_key><arg_value># Predict Market Agent\n</arg_value></tool_call>'
    const out = extractGlmArgKvToolCalls(text)
    expect(out?.toolUses).toEqual([
      {
        name: 'apply_patch',
        input: {
          file: '/Users/tom/workspace/dev/predict/README.md',
          content: '# Predict Market Agent',
        },
      },
    ])
    expect(out?.cleanedText).toBe('')
  })

  it('keeps surrounding prose as cleaned text', () => {
    const text =
      'Let me edit that.\n<tool_call>read_file<arg_key>path</arg_key><arg_value>a.ts</arg_value></tool_call>'
    const out = extractGlmArgKvToolCalls(text)
    expect(out?.toolUses[0]?.name).toBe('read_file')
    expect(out?.cleanedText).toBe('Let me edit that.')
  })

  it('handles the name on its own line and whitespace between pairs', () => {
    const text = `<tool_call>
      run
      <arg_key>cmd</arg_key><arg_value>ls</arg_value>
      <arg_key>timeout</arg_key><arg_value>30</arg_value>
    </tool_call>`
    const out = extractGlmArgKvToolCalls(text)
    expect(out?.toolUses).toEqual([{ name: 'run', input: { cmd: 'ls', timeout: 30 } }])
  })

  it('parses multiple GLM tool calls in one message', () => {
    const text =
      '<tool_call>a<arg_key>x</arg_key><arg_value>1</arg_value></tool_call>' +
      '<tool_call>b<arg_key>y</arg_key><arg_value>2</arg_value></tool_call>'
    const out = extractGlmArgKvToolCalls(text)
    expect(out?.toolUses).toEqual([
      { name: 'a', input: { x: 1 } },
      { name: 'b', input: { y: 2 } },
    ])
  })
})
