// OpenAI Chat Completions → neutral IR. The notable work is role flattening:
// OpenAI carries tool results as standalone `role:'tool'` messages, which the
// IR folds back into `tool_result` blocks on a user turn.

import { nanoid } from 'nanoid'
import type { NormalizedBlock } from '../../core/packet.ts'
import {
  type IRBlock,
  type IRMessage,
  type IRRequest,
  type IRResponse,
  type IRTool,
  canonicalStopReason,
  mergeConsecutive,
  urlToImageSource,
} from './ir.ts'
import { asObject, num, optNum, parseToolArgs, str } from './shared.ts'
import { extractInlineToolCallsXml } from './xml-tool-calls.ts'

export function requestToIR(body: unknown): IRRequest {
  const b = asObject(body)
  const messages: IRMessage[] = []
  let system: string | undefined
  if (Array.isArray(b.messages)) {
    for (const raw of b.messages) {
      const m = asObject(raw)
      if (m.role === 'system' || m.role === 'developer') {
        const t = contentToText(m.content)
        if (t.length > 0) system = system ? `${system}\n${t}` : t
        continue
      }
      if (m.role === 'tool') {
        messages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              toolUseId: str(m.tool_call_id) ?? '',
              content: [{ type: 'text', text: contentToText(m.content) }],
            },
          ],
        })
        continue
      }
      if (m.role === 'assistant') {
        const content: IRBlock[] = []
        const text = contentToText(m.content)
        if (text.length > 0) content.push({ type: 'text', text })
        if (Array.isArray(m.tool_calls)) {
          for (const raw2 of m.tool_calls) {
            const tc = asObject(raw2)
            const fn = asObject(tc.function)
            content.push({
              type: 'tool_use',
              id: str(tc.id) ?? '',
              name: str(fn.name) ?? '',
              input: parseToolArgs(fn.arguments),
            })
          }
        }
        messages.push({ role: 'assistant', content })
        continue
      }
      messages.push({ role: 'user', content: contentToBlocks(m.content) })
    }
  }
  return {
    model: str(b.model) ?? '',
    system,
    messages: mergeConsecutive(messages),
    tools: toolsToIR(b.tools),
    maxTokens: optNum(b.max_tokens) ?? optNum(b.max_completion_tokens),
    temperature: optNum(b.temperature),
    stream: b.stream === true,
  }
}

export function responseToIR(json: unknown): IRResponse {
  const j = asObject(json)
  const blocks: NormalizedBlock[] = []
  const choice = asObject(Array.isArray(j.choices) ? j.choices[0] : undefined)
  const msg = asObject(choice.message)
  const rawText = contentToText(msg.content)
  // Some models emit tool calls as inline XML in `content` instead of
  // populating the structured `tool_calls` field — Hermes/Qwen's
  // <tool_call> JSON form and Claude's legacy <invoke>/<parameter>
  // form both show up in the wild. Parse either one out so the XML
  // doesn't leak to the agent as literal text. Empty / malformed
  // wrappers parse as zero calls + stripped text — the original
  // "answer" becomes empty rather than a wall of broken XML.
  const xmlCalls = rawText.length > 0 ? extractInlineToolCallsXml(rawText) : null
  const text = xmlCalls ? xmlCalls.cleanedText : rawText
  if (text.length > 0) blocks.push({ type: 'text', text })
  if (xmlCalls) {
    for (const tu of xmlCalls.toolUses) {
      blocks.push({
        type: 'tool_use',
        // XML formats carry no tool_use_id; synthesize a GLOBALLY unique one.
        // A per-response counter collides across turns (every turn's call is
        // `afw_xml_0`), so a long history shares one id and the model can't
        // tell its actions apart. nanoid keeps each call distinct.
        id: `afw_xml_${nanoid()}`,
        name: tu.name,
        input: tu.input,
        ...(tu.rawJson ? { rawJson: tu.rawJson } : {}),
      })
    }
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const raw of msg.tool_calls) {
      const tc = asObject(raw)
      const fn = asObject(tc.function)
      blocks.push({
        type: 'tool_use',
        id: str(tc.id) ?? '',
        name: str(fn.name) ?? '',
        input: parseToolArgs(fn.arguments),
        rawJson: typeof fn.arguments === 'string' ? fn.arguments : undefined,
      })
    }
  }
  const usage = asObject(j.usage)
  return {
    model: str(j.model) ?? '',
    blocks,
    stopReason: canonicalStopReason(str(choice.finish_reason)),
    usage: {
      in: num(usage.prompt_tokens),
      out: num(usage.completion_tokens),
      cacheRead: optNum(asObject(usage.prompt_tokens_details).cached_tokens),
    },
  }
}

// ── helpers ───────────────────────────────────────────────────────

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        const o = asObject(p)
        return typeof o.text === 'string' ? o.text : ''
      })
      .join('')
  }
  return ''
}

function contentToBlocks(content: unknown): IRBlock[] {
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const blocks: IRBlock[] = []
  for (const raw of content) {
    const p = asObject(raw)
    if (p.type === 'text' || p.type === 'input_text') {
      blocks.push({ type: 'text', text: typeof p.text === 'string' ? p.text : '' })
    } else if (p.type === 'image_url') {
      const url = typeof p.image_url === 'string' ? p.image_url : str(asObject(p.image_url).url)
      if (url) blocks.push({ type: 'image', source: urlToImageSource(url) })
    }
  }
  return blocks
}

function toolsToIR(tools: unknown): IRTool[] | undefined {
  if (!Array.isArray(tools)) return undefined
  const out: IRTool[] = []
  for (const raw of tools) {
    const t = asObject(raw)
    const fn = asObject(t.function)
    const name = str(fn.name) ?? str(t.name)
    if (!name) continue
    out.push({
      name,
      description: str(fn.description) ?? str(t.description),
      inputSchema: fn.parameters ?? t.parameters ?? { type: 'object' },
    })
  }
  return out.length > 0 ? out : undefined
}
