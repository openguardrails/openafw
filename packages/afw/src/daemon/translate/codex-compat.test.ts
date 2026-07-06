import { describe, expect, it } from 'vitest'
import { downgradeCustomToolCallsForResponses } from './codex-compat.ts'

describe('downgradeCustomToolCallsForResponses', () => {
  it('rewrites custom_tool_call history to function_call (vLLM-safe)', () => {
    const body: Record<string, unknown> = {
      model: 'og-coding',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'edit it' }] },
        {
          type: 'custom_tool_call',
          call_id: 'c1',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** End Patch',
        },
        { type: 'custom_tool_call_output', call_id: 'c1', output: 'done' },
      ],
    }
    downgradeCustomToolCallsForResponses(body)
    const input = body.input as Array<Record<string, unknown>>
    expect(input[0]?.type).toBe('message')
    expect(input[1]).toEqual({
      type: 'function_call',
      call_id: 'c1',
      name: 'apply_patch',
      arguments: JSON.stringify({ input: '*** Begin Patch\n*** End Patch' }),
    })
    expect(input[2]).toEqual({ type: 'function_call_output', call_id: 'c1', output: 'done' })
    // no leftover custom_tool_call the vLLM Responses input builder crashes on
    expect(JSON.stringify(body)).not.toContain('custom_tool_call')
  })

  it('is a no-op when there are no custom tool calls', () => {
    const body: Record<string, unknown> = {
      input: [{ type: 'message', role: 'user', content: [] }],
    }
    const before = JSON.stringify(body)
    downgradeCustomToolCallsForResponses(body)
    expect(JSON.stringify(body)).toBe(before)
  })

  it('tolerates a string or missing input', () => {
    const body: Record<string, unknown> = { input: 'plain string input' }
    downgradeCustomToolCallsForResponses(body)
    expect(body.input).toBe('plain string input')
  })
})
